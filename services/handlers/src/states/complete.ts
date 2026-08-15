import {
  Metrics,
  NonRetryableError,
  emitMetric,
  type JobStatus,
  type Platform,
  type PlatformPublishState,
  type WorkflowState,
} from '@mrp/shared';

import { getRuntime, type Runtime } from '../context.js';

/**
 * Complete.
 *
 * A job is only COMPLETED once every requested platform has a definitive result.
 * Partial success is a first-class outcome: Instagram published while Facebook
 * is still retryable leaves the job PARTIALLY_COMPLETED, which keeps it visible
 * to the operator instead of quietly claiming success.
 */

export interface CompleteResult extends WorkflowState {
  summary: {
    jobId: string;
    status: JobStatus;
    platforms: Array<{
      platform: Platform;
      status: string;
      mediaId?: string | undefined;
      permalink?: string | undefined;
    }>;
  };
}

const isDefinitive = (state: PlatformPublishState | undefined): boolean =>
  state === undefined || state.status === 'PUBLISHED' || state.status === 'FAILED' || state.status === 'SKIPPED';

export const complete = async (
  state: WorkflowState,
  runtime: Runtime = getRuntime(),
): Promise<CompleteResult> => {
  const { config, repository, logger } = runtime;
  const log = logger.child({ jobId: state.jobId, state: 'Complete' });

  const job = await repository.getJob(state.jobId);
  if (!job) throw new NonRetryableError(`Job ${state.jobId} not found`);

  const platforms: Partial<Record<Platform, PlatformPublishState>> = {};
  for (const platform of config.ENABLED_PLATFORMS) {
    const publishState = await repository.getPublishState(state.jobId, platform);
    if (publishState) platforms[platform] = publishState;
  }

  const results = config.ENABLED_PLATFORMS.map((platform) => platforms[platform]);
  const published = results.filter((entry) => entry?.status === 'PUBLISHED').length;
  const definitive = results.every(isDefinitive);

  let status: JobStatus;
  if (published === config.ENABLED_PLATFORMS.length) {
    status = 'COMPLETED';
  } else if (published > 0) {
    status = 'PARTIALLY_COMPLETED';
  } else if (definitive) {
    status = 'FAILED';
  } else {
    // Something is still retryable: leave the job open for the operator rather
    // than marking it done.
    status = 'MANUAL_REVIEW';
  }

  const summary = {
    jobId: state.jobId,
    status,
    platforms: config.ENABLED_PLATFORMS.map((platform) => ({
      platform,
      status: platforms[platform]?.status ?? 'PENDING',
      mediaId: platforms[platform]?.mediaId,
      permalink: platforms[platform]?.permalink,
    })),
  };

  await repository.updateJob(state.jobId, { status, platforms });
  await repository.appendEvent(state.jobId, {
    at: runtime.clock().toISOString(),
    type: 'JOB_FINISHED',
    actor: 'workflow',
    detail: summary,
  });

  if (status === 'COMPLETED' || status === 'PARTIALLY_COMPLETED') {
    // Only a definitive outcome closes the idempotency record; a replay before
    // this point re-enters the workflow rather than returning a half result.
    await repository.completeIdempotency(job.idempotencyKey, summary);
  }

  if (status === 'MANUAL_REVIEW') {
    await repository.openReview(state.jobId, 'publish_incomplete');
    emitMetric(Metrics.manualReviewQueued, 1, { Environment: config.ENVIRONMENT });
  }

  emitMetric(
    status === 'FAILED' ? Metrics.jobsFailed : Metrics.jobsCompleted,
    1,
    { Environment: config.ENVIRONMENT, Status: status },
  );
  log.info('Job finished', { status, published });

  return { ...state, status, summary };
};

export const handler = async (state: WorkflowState): Promise<CompleteResult> => complete(state);
