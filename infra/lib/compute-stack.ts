import { fileURLToPath } from 'node:url';

import {
  Duration,
  Stack,
  type StackProps,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { resourceName, type DeploySettings } from './config.js';
import type { FoundationStack } from './foundation-stack.js';
import { createNodeFunction, lambdaRole } from './lambda-factory.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const entry = (relative: string): string => `${repoRoot}/${relative}`;

export interface ComputeStackProps extends StackProps {
  settings: DeploySettings;
  foundation: FoundationStack;
}

/**
 * Functions and IAM.
 *
 * Five separate execution roles, each scoped to the S3 key prefixes and APIs it
 * actually needs:
 *
 *   orchestration - job lifecycle bookkeeping (table + kill switch)
 *   generation    - models and validation; may write raw/ and images/ only
 *   renderer      - reads images/ and music/, writes renders/ and manifests/
 *   publisher     - reads renders/, writes receipts/, reads the Meta secret
 *   scheduler     - may only start a state machine execution
 *
 * No role can both read the Meta secret and write source images, so a compromise
 * of the generation path cannot reach publishing credentials.
 */
export class ComputeStack extends Stack {
  public readonly functions: Record<string, lambda.IFunction> = {};

  public readonly rendererFunction: lambda.DockerImageFunction;

  public readonly validateVideoFunction: lambda.DockerImageFunction;

  public readonly adminFunction: nodejs.NodejsFunction;

  /** Shared, non-secret environment handed to functions created elsewhere. */
  public readonly baseEnvironment: Record<string, string>;

  /** Exposed so the workflow stack can create the scheduled invoker's function. */
  public readonly orchestrationRole: iam.Role;

  private readonly settings: DeploySettings;

  private readonly foundation: FoundationStack;

  private readonly asyncDlq: sqs.Queue;

  public constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    this.settings = props.settings;
    this.foundation = props.foundation;
    const { foundation, settings } = props;

    this.asyncDlq = foundation.deadLetterQueue;

    // ---------------------------------------------------------------- roles
    const orchestrationRole = this.makeRole('OrchestrationRole', 'orchestration');
    this.orchestrationRole = orchestrationRole;
    const generationRole = this.makeRole('GenerationRole', 'generation');
    const rendererRole = this.makeRole('RendererRole', 'renderer');
    const publisherRole = this.makeRole('PublisherRole', 'publisher');
    const adminRole = this.makeRole('AdminRole', 'admin');

    for (const role of [orchestrationRole, generationRole, rendererRole, publisherRole, adminRole]) {
      foundation.table.grantReadWriteData(role);
      foundation.killSwitchParameter.grantRead(role);
    }

    // S3: scoped strictly by key prefix.
    this.grantPrefix(generationRole, ['raw/*', 'images/*'], 'write');
    this.grantPrefix(generationRole, ['images/*'], 'read');
    this.grantPrefix(rendererRole, ['images/*', 'music/*'], 'read');
    this.grantPrefix(rendererRole, ['renders/*', 'manifests/*'], 'write');
    this.grantPrefix(rendererRole, ['renders/*'], 'read');
    this.grantPrefix(publisherRole, ['renders/*', 'manifests/*'], 'read');
    this.grantPrefix(publisherRole, ['receipts/*'], 'write');
    this.grantPrefix(adminRole, ['manifests/*', 'receipts/*'], 'read');

    foundation.assetsKey.grantEncryptDecrypt(generationRole);
    foundation.assetsKey.grantEncryptDecrypt(rendererRole);
    foundation.assetsKey.grantDecrypt(publisherRole);
    foundation.assetsKey.grantDecrypt(adminRole);

    // Only the publisher may read Meta credentials.
    foundation.metaSecret.grantRead(publisherRole);

    // Model access. Resource is "*" because the model id is configuration and
    // may be a cross-region inference profile; narrow this to the specific model
    // ARNs once they are confirmed for the account (see docs/operations.md).
    generationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );
    generationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:DetectText', 'rekognition:DetectModerationLabels'],
        resources: ['*'],
      }),
    );

    // ------------------------------------------------------------ functions
    this.functions.createJob = this.makeFunction('CreateJob', {
      entry: entry('services/handlers/src/states/create-job.ts'),
      role: orchestrationRole,
      timeout: Duration.seconds(30),
    });
    this.functions.generateQuote = this.makeFunction('GenerateQuote', {
      entry: entry('services/handlers/src/states/generate-quote.ts'),
      role: generationRole,
      timeout: Duration.minutes(2),
    });
    this.functions.generateImage = this.makeFunction('GenerateImage', {
      entry: entry('services/handlers/src/states/generate-image.ts'),
      role: generationRole,
      timeout: Duration.minutes(5),
      memorySize: 1_024,
      // Bounds concurrent spend on the image model.
      reservedConcurrentExecutions: 4,
    });
    this.functions.validateImage = this.makeFunction('ValidateImage', {
      entry: entry('services/handlers/src/states/validate-image.ts'),
      role: generationRole,
      timeout: Duration.minutes(2),
      memorySize: 1_536,
    });
    this.functions.scheduleOrPublish = this.makeFunction('ScheduleOrPublish', {
      entry: entry('services/handlers/src/states/schedule-or-publish.ts'),
      role: publisherRole,
      timeout: Duration.seconds(60),
    });
    this.functions.complete = this.makeFunction('Complete', {
      entry: entry('services/handlers/src/states/complete.ts'),
      role: orchestrationRole,
      timeout: Duration.seconds(60),
    });
    this.functions.handleFailure = this.makeFunction('HandleFailure', {
      entry: entry('services/handlers/src/states/handle-failure.ts'),
      role: orchestrationRole,
      timeout: Duration.seconds(60),
    });

    for (const platform of ['Instagram', 'Facebook'] as const) {
      const source = entry(
        `services/handlers/src/states/publish-${platform.toLowerCase()}.ts`,
      );
      this.functions[`${platform.toLowerCase()}CreateContainer`] = this.makeFunction(
        `${platform}CreateContainer`,
        {
          entry: source,
          handler: 'createContainerHandler',
          role: publisherRole,
          timeout: Duration.minutes(2),
          reservedConcurrentExecutions: 2,
        },
      );
      this.functions[`${platform.toLowerCase()}CheckStatus`] = this.makeFunction(
        `${platform}CheckStatus`,
        { entry: source, handler: 'checkStatusHandler', role: publisherRole },
      );
      this.functions[`${platform.toLowerCase()}Publish`] = this.makeFunction(
        `${platform}Publish`,
        {
          entry: source,
          handler: 'publishHandler',
          role: publisherRole,
          timeout: Duration.minutes(2),
          reservedConcurrentExecutions: 2,
        },
      );
      this.functions[`${platform.toLowerCase()}Failure`] = this.makeFunction(
        `${platform}Failure`,
        { entry: source, handler: 'failureHandler', role: publisherRole },
      );
    }

    // ------------------------------------------------- renderer (container)
    const repository = ecr.Repository.fromRepositoryAttributes(this, 'RendererRepoRef', {
      repositoryName: foundation.rendererRepository.repositoryName,
      repositoryArn: foundation.rendererRepository.repositoryArn,
    });

    this.baseEnvironment = {
      ...settings.runtimeEnv,
      TABLE_NAME: foundation.table.tableName,
      ASSETS_BUCKET: foundation.assetsBucket.bucketName,
      META_SECRET_ARN: foundation.metaSecret.secretArn,
      KILL_SWITCH_PARAMETER_NAME: foundation.killSwitchParameter.parameterName,
    };

    const rendererEnv = {
      ...settings.runtimeEnv,
      TABLE_NAME: foundation.table.tableName,
      ASSETS_BUCKET: foundation.assetsBucket.bucketName,
      KILL_SWITCH_PARAMETER_NAME: foundation.killSwitchParameter.parameterName,
    };

    this.rendererFunction = new lambda.DockerImageFunction(this, 'RenderReel', {
      functionName: resourceName(settings, 'render-reel'),
      // Image is built and pushed by CI, not by `cdk synth`, so synth needs no
      // Docker daemon. See docs/decisions.md.
      code: lambda.DockerImageCode.fromEcr(repository, {
        tagOrDigest: settings.rendererImageTag,
        cmd: ['handler.handler'],
      }),
      role: rendererRole,
      memorySize: 4_096,
      ephemeralStorageSize: undefined,
      timeout: Duration.minutes(10),
      environment: rendererEnv,
      reservedConcurrentExecutions: 3,
      logRetention: logs.RetentionDays.ONE_MONTH,
      deadLetterQueueEnabled: true,
      deadLetterQueue: this.asyncDlq,
    });

    this.validateVideoFunction = new lambda.DockerImageFunction(this, 'ValidateVideo', {
      functionName: resourceName(settings, 'validate-video'),
      code: lambda.DockerImageCode.fromEcr(repository, {
        tagOrDigest: settings.rendererImageTag,
        cmd: ['validate-handler.handler'],
      }),
      role: rendererRole,
      memorySize: 2_048,
      timeout: Duration.minutes(5),
      environment: rendererEnv,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // --------------------------------------------------- operational lambdas
    this.adminFunction = this.makeFunction('Admin', {
      entry: entry('services/handlers/src/admin/handler.ts'),
      role: adminRole,
      timeout: Duration.seconds(60),
    });
  }

  private makeRole(id: string, purpose: string): iam.Role {
    return lambdaRole(this, id, this.settings, purpose);
  }

  /** Grants S3 access to specific key prefixes only - never the whole bucket. */
  private grantPrefix(role: iam.IRole, prefixes: string[], mode: 'read' | 'write'): void {
    const actions =
      mode === 'read'
        ? ['s3:GetObject', 's3:GetObjectVersion']
        : ['s3:PutObject', 's3:AbortMultipartUpload'];
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions,
        resources: prefixes.map(
          (prefix) => `${this.foundation.assetsBucket.bucketArn}/${prefix}`,
        ),
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [this.foundation.assetsBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': prefixes } },
      }),
    );
  }

  private makeFunction(
    id: string,
    options: {
      entry: string;
      role: iam.IRole;
      handler?: string;
      timeout?: Duration;
      memorySize?: number;
      reservedConcurrentExecutions?: number;
    },
  ): nodejs.NodejsFunction {
    return createNodeFunction(this, id, {
      settings: this.settings,
      environment: {
        ...this.settings.runtimeEnv,
        TABLE_NAME: this.foundation.table.tableName,
        ASSETS_BUCKET: this.foundation.assetsBucket.bucketName,
        META_SECRET_ARN: this.foundation.metaSecret.secretArn,
        KILL_SWITCH_PARAMETER_NAME: this.foundation.killSwitchParameter.parameterName,
      },
      ...options,
    });
  }
}
