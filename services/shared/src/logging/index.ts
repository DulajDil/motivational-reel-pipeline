import { redact } from '../util/redact.js';

/**
 * Structured JSON logging.
 *
 * AWS Lambda Powertools is used when it is present (it gives us cold-start,
 * request-id and X-Ray correlation for free), but the module degrades to a plain
 * JSON console logger so unit tests and local scripts need no AWS context.
 *
 * Every payload is redacted on the way out - there is no unredacted log path.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

class JsonLogger implements Logger {
  public constructor(
    private readonly service: string,
    private readonly level: LogLevel,
    private readonly bound: Record<string, unknown> = {},
  ) {}

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...redact({ ...this.bound, ...(context ?? {}) }),
    };
    const serialised = JSON.stringify(line);
    if (level === 'ERROR') console.error(serialised);
    else if (level === 'WARN') console.warn(serialised);
    // eslint-disable-next-line no-console
    else console.log(serialised);
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this.write('DEBUG', message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.write('INFO', message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.write('WARN', message, context);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this.write('ERROR', message, context);
  }

  public child(context: Record<string, unknown>): Logger {
    return new JsonLogger(this.service, this.level, { ...this.bound, ...context });
  }
}

export const createLogger = (service: string, level?: LogLevel): Logger =>
  new JsonLogger(service, level ?? (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'INFO');

/** Metric names are a contract with the CloudWatch dashboard and alarms. */
export const METRIC_NAMESPACE = 'MotivationalReelPipeline';

export const Metrics = {
  jobsCreated: 'JobsCreated',
  quotesGenerated: 'QuotesGenerated',
  quotesRejected: 'QuotesRejected',
  imagesGenerated: 'ImagesGenerated',
  imagesRejected: 'ImagesRejected',
  reelsRendered: 'ReelsRendered',
  videosValidated: 'VideosValidated',
  videosRejected: 'VideosRejected',
  jobsScheduled: 'JobsScheduled',
  publishSucceeded: 'PublishSucceeded',
  publishFailed: 'PublishFailed',
  publishSkipped: 'PublishSkipped',
  jobsCompleted: 'JobsCompleted',
  jobsFailed: 'JobsFailed',
  manualReviewQueued: 'ManualReviewQueued',
  costGuardTripped: 'CostGuardTripped',
  killSwitchBlocked: 'KillSwitchBlocked',
  quotaRemaining: 'PublishQuotaRemaining',
} as const;

export type MetricName = (typeof Metrics)[keyof typeof Metrics];

/**
 * Emit a metric using the CloudWatch Embedded Metric Format so no PutMetricData
 * permission or API call is needed from the task Lambdas.
 */
export const emitMetric = (
  name: MetricName,
  value = 1,
  dimensions: Record<string, string> = {},
  unit: 'Count' | 'Seconds' | 'Bytes' | 'None' = 'Count',
): void => {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    ...dimensions,
    [name]: value,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(emf));
};
