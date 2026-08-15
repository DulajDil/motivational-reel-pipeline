import { fileURLToPath } from 'node:url';

import {
  Duration,
  Stack,
  type StackProps,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_scheduler as scheduler,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { resourceName, type DeploySettings } from './config.js';
import type { ComputeStack } from './compute-stack.js';
import type { FoundationStack } from './foundation-stack.js';
import { createNodeFunction, lambdaRole } from './lambda-factory.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface WorkflowStackProps extends StackProps {
  settings: DeploySettings;
  foundation: FoundationStack;
  compute: ComputeStack;
}

/** Error names the machine matches on. Mirrors services/shared/src/errors. */
const ERR = {
  retryable: 'RetryableError',
  nonRetryable: 'NonRetryableError',
  manualReview: 'ManualReviewRequiredError',
  configuration: 'ConfigurationError',
  guard: 'GuardTrippedError',
} as const;

/**
 * The state machine.
 *
 * Standard workflow, because a job can legitimately sit in a Wait state for
 * hours until its posting window opens, and because every state transition
 * needs to be durable and auditable.
 *
 * Retry ownership is explicit: Step Functions retries `RetryableError` with
 * exponential backoff and jitter; handlers never retry a whole task themselves.
 * Every terminal error routes to HandleFailure, which parks the job in the right
 * place instead of failing silently.
 */
export class WorkflowStack extends Stack {
  public readonly stateMachine: sfn.StateMachine;

  public constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);
    const { settings, compute, foundation } = props;

    const pollIntervalSeconds = Number(settings.runtimeEnv.CONTAINER_POLL_INTERVAL_SECONDS ?? 15);

    const invoke = (
      id_: string,
      fn: lambda.IFunction,
      options: { retryable?: boolean; timeout?: Duration } = {},
    ): tasks.LambdaInvoke => {
      const task = new tasks.LambdaInvoke(this, id_, {
        lambdaFunction: fn,
        payloadResponseOnly: true,
        taskTimeout: sfn.Timeout.duration(options.timeout ?? Duration.minutes(10)),
      });
      if (options.retryable !== false) {
        task.addRetry({
          errors: [ERR.retryable, 'Lambda.ServiceException', 'Lambda.TooManyRequestsException'],
          interval: Duration.seconds(5),
          maxAttempts: 3,
          backoffRate: 2,
          // Full jitter: decorrelates concurrent retries against the same model
          // or the same Graph endpoint.
          jitterStrategy: sfn.JitterType.FULL,
        });
      }
      return task;
    };

    // ------------------------------------------------------------ terminals
    const handleFailure = invoke('HandleFailureTask', compute.functions.handleFailure!, {
      retryable: false,
    });
    const failed = new sfn.Fail(this, 'JobFailed', { error: 'JobFailed' });
    handleFailure.next(failed);

    const catchAll = {
      errors: [sfn.Errors.ALL],
      resultPath: '$.error',
    };

    const succeeded = new sfn.Succeed(this, 'JobSucceeded');
    const awaitingApproval = new sfn.Succeed(this, 'AwaitingManualApproval', {
      comment: 'Rendered and parked for human approval; nothing was published.',
    });

    // ------------------------------------------------------------- pipeline
    const completeTask = invoke('CompleteTask', compute.functions.complete!).addCatch(
      handleFailure,
      catchAll,
    );
    completeTask.next(succeeded);

    const publishParallel = new sfn.Parallel(this, 'PublishToPlatforms', {
      comment:
        'Instagram and Facebook are separate transactions; one failing does not fail the other.',
      resultPath: '$.publishResults',
    });

    for (const platform of ['Instagram', 'Facebook'] as const) {
      const key = platform.toLowerCase();

      const createContainer = invoke(
        `${platform}CreateContainerTask`,
        compute.functions[`${key}CreateContainer`]!,
      );
      const checkStatus = invoke(
        `${platform}CheckStatusTask`,
        compute.functions[`${key}CheckStatus`]!,
      );
      const publish = invoke(`${platform}PublishTask`, compute.functions[`${key}Publish`]!);
      const branchFailure = invoke(
        `${platform}FailureTask`,
        compute.functions[`${key}Failure`]!,
        { retryable: false },
      );
      const branchDone = new sfn.Pass(this, `${platform}BranchDone`);
      branchFailure.next(branchDone);

      for (const task of [createContainer, checkStatus, publish]) {
        task.addCatch(branchFailure, catchAll);
      }

      const waitForContainer = new sfn.Wait(this, `${platform}WaitForContainer`, {
        time: sfn.WaitTime.duration(Duration.seconds(pollIntervalSeconds)),
      });

      // FINISHED -> publish; EXPIRED -> build a fresh container; otherwise keep
      // waiting. `checkPublishStatus` bounds the loop and throws once the poll
      // budget is spent, so this cannot spin forever.
      const statusChoice = new sfn.Choice(this, `${platform}ContainerReady?`)
        .when(sfn.Condition.booleanEquals('$.publishSkipped', true), branchDone)
        .when(sfn.Condition.stringEquals('$.containerStatus', 'FINISHED'), publish)
        .when(sfn.Condition.stringEquals('$.containerStatus', 'EXPIRED'), createContainer)
        .otherwise(waitForContainer);

      publish.next(branchDone);
      waitForContainer.next(checkStatus);
      checkStatus.next(statusChoice);

      createContainer.next(
        new sfn.Choice(this, `${platform}ContainerCreated?`)
          .when(sfn.Condition.booleanEquals('$.publishSkipped', true), branchDone)
          .otherwise(waitForContainer),
      );

      publishParallel.branch(createContainer);
    }

    publishParallel.addCatch(handleFailure, catchAll);
    publishParallel.next(completeTask);

    const waitUntilScheduled = new sfn.Wait(this, 'WaitForPublishWindow', {
      // Durable wait, not a poll: the execution sleeps until the window opens.
      time: sfn.WaitTime.timestampPath('$.scheduledFor'),
    });
    waitUntilScheduled.next(publishParallel);

    const scheduleTask = invoke('ScheduleOrPublishTask', compute.functions.scheduleOrPublish!)
      .addCatch(handleFailure, catchAll);
    scheduleTask.next(
      new sfn.Choice(this, 'PublishDecision')
        .when(sfn.Condition.stringEquals('$.decision', 'proceed'), publishParallel)
        .when(sfn.Condition.stringEquals('$.decision', 'deferred'), waitUntilScheduled)
        .when(sfn.Condition.stringEquals('$.decision', 'await_approval'), awaitingApproval)
        .otherwise(completeTask),
    );

    const validateVideo = invoke('ValidateVideoTask', compute.validateVideoFunction, {
      timeout: Duration.minutes(6),
    }).addCatch(handleFailure, catchAll);
    validateVideo.next(scheduleTask);

    const renderReel = invoke('RenderReelTask', compute.rendererFunction, {
      timeout: Duration.minutes(12),
    }).addCatch(handleFailure, catchAll);
    renderReel.next(validateVideo);

    const generateImage = invoke('GenerateImageTask', compute.functions.generateImage!).addCatch(
      handleFailure,
      catchAll,
    );
    const validateImage = invoke('ValidateImageTask', compute.functions.validateImage!).addCatch(
      handleFailure,
      catchAll,
    );

    generateImage.next(validateImage);
    validateImage.next(
      new sfn.Choice(this, 'ImageAcceptable?')
        .when(sfn.Condition.booleanEquals('$.imageValid', true), renderReel)
        // Bounded: ValidateImage throws ManualReviewRequiredError once the
        // attempt budget is exhausted, so this loop always terminates.
        .otherwise(generateImage),
    );

    const generateQuote = invoke('GenerateQuoteTask', compute.functions.generateQuote!).addCatch(
      handleFailure,
      catchAll,
    );
    generateQuote.next(generateImage);

    const createJob = invoke('CreateJobTask', compute.functions.createJob!).addCatch(
      handleFailure,
      catchAll,
    );
    createJob.next(
      new sfn.Choice(this, 'AlreadyComplete?')
        .when(sfn.Condition.booleanEquals('$.alreadyComplete', true), succeeded)
        .otherwise(generateQuote),
    );

    // ------------------------------------------------------- state machine
    this.stateMachine = new sfn.StateMachine(this, 'ReelPipeline', {
      stateMachineName: resourceName(settings, 'pipeline'),
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(createJob),
      timeout: Duration.hours(26),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'PipelineLogs', {
          logGroupName: `/aws/vendedlogs/states/${resourceName(settings, 'pipeline')}`,
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false, // execution data can carry captions and URLs
      },
    });

    // --------------------------------------------------------- daily batch
    // The batch trigger is created here, not in the compute stack, because it
    // needs the state machine ARN; putting it there would make the two stacks
    // reference each other.
    const batchRole = lambdaRole(this, 'BatchTriggerRole', settings, 'batch-trigger');
    foundation.table.grantReadWriteData(batchRole);
    foundation.killSwitchParameter.grantRead(batchRole);

    const batchTriggerFunction = createNodeFunction(this, 'BatchTrigger', {
      settings,
      entry: `${repoRoot}/services/handlers/src/batch-trigger.ts`,
      role: batchRole,
      timeout: Duration.minutes(2),
      environment: {
        ...compute.baseEnvironment,
        STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
      },
    });
    this.stateMachine.grantStartExecution(batchRole);

    const invokerRole = new iam.Role(this, 'ScheduledInvokerRole', {
      roleName: resourceName(settings, 'scheduled-invoker-role'),
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'May only invoke the batch trigger function.',
    });
    batchTriggerFunction.grantInvoke(invokerRole);

    // EventBridge Scheduler is used instead of a plain rule because it honours
    // an IANA timezone, so the batch keeps tracking local time across DST.
    new scheduler.CfnSchedule(this, 'DailyBatchSchedule', {
      name: resourceName(settings, 'daily-batch'),
      description: 'Starts the daily batch of reel generation jobs.',
      flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: 15 },
      scheduleExpression: 'cron(0 6 * * ? *)',
      scheduleExpressionTimezone: settings.runtimeEnv.SCHEDULE_TIMEZONE ?? 'Pacific/Auckland',
      target: {
        arn: batchTriggerFunction.functionArn,
        roleArn: invokerRole.roleArn,
        input: JSON.stringify({}),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3_600 },
        deadLetterConfig: { arn: foundation.deadLetterQueue.queueArn },
      },
    });

    foundation.deadLetterQueue.grantSendMessages(invokerRole);
  }
}
