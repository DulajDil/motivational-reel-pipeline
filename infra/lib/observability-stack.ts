import {
  Duration,
  Stack,
  type StackProps,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cwActions,
  aws_sns_subscriptions as subs,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { resourceName, type DeploySettings } from './config.js';
import type { ComputeStack } from './compute-stack.js';
import type { FoundationStack } from './foundation-stack.js';
import type { WorkflowStack } from './workflow-stack.js';

const NAMESPACE = 'MotivationalReelPipeline';

export interface ObservabilityStackProps extends StackProps {
  settings: DeploySettings;
  foundation: FoundationStack;
  compute: ComputeStack;
  workflow: WorkflowStack;
}

/**
 * Alarms and dashboard.
 *
 * Every alarm treats missing data as "not breaching" except the ones that would
 * hide a stalled pipeline, and each one points at the runbook section that
 * explains what to do (docs/operations.md).
 */
export class ObservabilityStack extends Stack {
  public constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { settings, foundation, compute, workflow } = props;

    if (settings.alarmEmail) {
      foundation.alarmTopic.addSubscription(new subs.EmailSubscription(settings.alarmEmail));
    }

    const pipelineMetric = (name: string, statistic = 'Sum'): cw.Metric =>
      new cw.Metric({
        namespace: NAMESPACE,
        metricName: name,
        dimensionsMap: { Environment: settings.environment },
        statistic,
        period: Duration.minutes(15),
      });

    const alarm = (
      id_: string,
      metric: cw.IMetric,
      threshold: number,
      description: string,
      evaluationPeriods = 1,
    ): cw.Alarm => {
      const created = new cw.Alarm(this, id_, {
        alarmName: resourceName(settings, id_.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()),
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${description} Runbook: docs/operations.md`,
      });
      created.addAlarmAction(new cwActions.SnsAction(foundation.alarmTopic));
      return created;
    };

    // --------------------------------------------------------------- alarms
    alarm(
      'WorkflowFailures',
      workflow.stateMachine.metricFailed({ period: Duration.minutes(15) }),
      1,
      'One or more pipeline executions failed.',
    );

    alarm(
      'DlqMessages',
      foundation.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(15),
      }),
      1,
      'Messages are sitting in the dead-letter queue.',
    );

    alarm(
      'PublishFailures',
      pipelineMetric('PublishFailed'),
      1,
      'A publish to Instagram or Facebook failed.',
    );

    alarm(
      'RenderErrors',
      compute.rendererFunction.metricErrors({ period: Duration.minutes(15) }),
      1,
      'The renderer function errored.',
    );

    alarm(
      'ManualReviewBacklog',
      pipelineMetric('ManualReviewQueued'),
      3,
      'Several jobs have been parked for manual review.',
    );

    alarm(
      'CostGuardTripped',
      pipelineMetric('CostGuardTripped'),
      1,
      'The soft spend guard stopped new work.',
    );

    alarm(
      'KillSwitchBlocking',
      pipelineMetric('KillSwitchBlocked'),
      1,
      'The kill switch is engaged and is blocking scheduled work.',
    );

    // Low remaining Instagram quota. Minimum statistic, because any single
    // reading at zero means the next publish will be refused.
    new cw.Alarm(this, 'LowPublishQuota', {
      alarmName: resourceName(settings, 'low-publish-quota'),
      metric: new cw.Metric({
        namespace: NAMESPACE,
        metricName: 'PublishQuotaRemaining',
        dimensionsMap: { Environment: settings.environment, Platform: 'instagram' },
        statistic: 'Minimum',
        period: Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Instagram publishing quota is nearly exhausted. Runbook: docs/operations.md',
    }).addAlarmAction(new cwActions.SnsAction(foundation.alarmTopic));

    // ------------------------------------------------------------ dashboard
    const dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: resourceName(settings, 'pipeline'),
    });

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'Pipeline funnel',
        left: [
          pipelineMetric('JobsCreated'),
          pipelineMetric('QuotesGenerated'),
          pipelineMetric('ImagesGenerated'),
          pipelineMetric('ReelsRendered'),
          pipelineMetric('VideosValidated'),
          pipelineMetric('JobsScheduled'),
          pipelineMetric('PublishSucceeded'),
        ],
        width: 24,
        height: 7,
      }),
    );

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'Rejections and failures',
        left: [
          pipelineMetric('QuotesRejected'),
          pipelineMetric('ImagesRejected'),
          pipelineMetric('VideosRejected'),
          pipelineMetric('PublishFailed'),
          pipelineMetric('PublishSkipped'),
          pipelineMetric('JobsFailed'),
          pipelineMetric('ManualReviewQueued'),
        ],
        width: 12,
        height: 6,
      }),
      new cw.GraphWidget({
        title: 'Guards',
        left: [
          pipelineMetric('CostGuardTripped'),
          pipelineMetric('KillSwitchBlocked'),
          pipelineMetric('PublishQuotaRemaining', 'Minimum'),
        ],
        width: 12,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      new cw.SingleValueWidget({
        title: 'Executions',
        metrics: [
          workflow.stateMachine.metricStarted(),
          workflow.stateMachine.metricSucceeded(),
          workflow.stateMachine.metricFailed(),
          workflow.stateMachine.metricTimedOut(),
        ],
        width: 24,
        height: 5,
      }),
    );
  }
}
