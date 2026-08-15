import {
  GuardTrippedError,
  Metrics,
  NonRetryableError,
  emitMetric,
  isWithinPublishWindow,
  nextPublishInstant,
  publishIdempotencyKey,
  type Platform,
  type PlatformPublishState,
  type WorkflowState,
} from '@mrp/shared';

import { getRuntime, type Runtime } from '../context.js';

/**
 * ScheduleOrPublish.
 *
 * Decides, per platform, whether this job may proceed to a publish and when.
 *
 *   proceed         - inside a posting window, cap available, go now
 *   deferred        - outside a posting window; the state machine waits until
 *                     `scheduledFor` rather than polling
 *   await_approval  - PUBLISH_MODE=manual_approval; parked in the review queue
 *   skipped         - kill switch, daily cap reached, or platform disabled
 *
 * Publish state rows are created here with a conditional write keyed on the
 * rendered asset's checksum. That row - not this decision - is what actually
 * prevents the same asset being posted to the same platform twice.
 */

export type ScheduleDecision = 'proceed' | 'deferred' | 'await_approval' | 'skipped';

export interface PlatformDecision {
  platform: Platform;
  allowed: boolean;
  reason?: string;
}

export interface ScheduleResult extends WorkflowState {
  decision: ScheduleDecision;
  scheduledFor: string;
  platformDecisions: PlatformDecision[];
  /** Platforms that should actually run their publish branch. */
  publishTargets: Platform[];
}

export const scheduleOrPublish = async (
  state: WorkflowState,
  runtime: Runtime = getRuntime(),
): Promise<ScheduleResult> => {
  const { config, repository, logger, clock } = runtime;
  const log = logger.child({ jobId: state.jobId, state: 'ScheduleOrPublish' });

  const job = await repository.getJob(state.jobId);
  if (!job?.render) throw new NonRetryableError(`Job ${state.jobId} has no render to publish`);
  if (job.videoValidation && !job.videoValidation.passed) {
    throw new NonRetryableError(`Job ${state.jobId} failed video validation; refusing to publish`);
  }

  const now = clock();
  const base = {
    ...state,
    scheduledFor: now.toISOString(),
    platformDecisions: [] as PlatformDecision[],
    publishTargets: [] as Platform[],
  };

  if (await runtime.killSwitch.isEngaged()) {
    emitMetric(Metrics.killSwitchBlocked, 1, { Environment: config.ENVIRONMENT });
    await repository.updateJob(state.jobId, { status: 'SCHEDULED' });
    log.warn('Kill switch engaged; skipping publish without deleting assets');
    return {
      ...base,
      status: 'SCHEDULED',
      decision: 'skipped',
      platformDecisions: config.ENABLED_PLATFORMS.map((platform) => ({
        platform,
        allowed: false,
        reason: 'kill_switch',
      })),
    };
  }

  const checksum = job.render.outputChecksumSha256;
  const decisions: PlatformDecision[] = [];
  const targets: Platform[] = [];

  for (const platform of config.ENABLED_PLATFORMS) {
    const existing = await repository.getPublishState(state.jobId, platform);
    if (existing?.status === 'PUBLISHED') {
      // Already live. Never repost without an explicit operator retry.
      decisions.push({ platform, allowed: false, reason: 'already_published' });
      continue;
    }

    const quota = await repository.consumeDailyQuota(
      platform,
      job.publishDate,
      config.MAX_DAILY_PUBLISHES_PER_PLATFORM,
    );
    if (!quota.allowed) {
      emitMetric(Metrics.publishSkipped, 1, { Environment: config.ENVIRONMENT, Platform: platform });
      decisions.push({ platform, allowed: false, reason: 'daily_cap_reached' });
      continue;
    }

    const publishState: PlatformPublishState = {
      platform,
      status: 'PENDING',
      idempotencyKey: publishIdempotencyKey(state.jobId, platform, checksum),
      attempts: 0,
      firstAttemptAt: now.toISOString(),
    };
    if (!existing) {
      await repository.initPublishState({ ...publishState, jobId: state.jobId });
    }

    decisions.push({ platform, allowed: true });
    targets.push(platform);
  }

  if (targets.length === 0) {
    await repository.updateJob(state.jobId, { status: 'SCHEDULED' });
    return { ...base, status: 'SCHEDULED', decision: 'skipped', platformDecisions: decisions };
  }

  if (config.PUBLISH_MODE === 'manual_approval') {
    await repository.openReview(state.jobId, 'awaiting_publish_approval');
    await repository.updateJob(state.jobId, { status: 'MANUAL_REVIEW' });
    emitMetric(Metrics.manualReviewQueued, 1, { Environment: config.ENVIRONMENT });
    log.info('Parked for manual approval');
    return {
      ...base,
      status: 'MANUAL_REVIEW',
      decision: 'await_approval',
      platformDecisions: decisions,
      publishTargets: targets,
    };
  }

  const inWindow = isWithinPublishWindow(now, config.SCHEDULE_TIMEZONE, config.publishWindows);
  const scheduledFor = inWindow
    ? now
    : nextPublishInstant(now, config.SCHEDULE_TIMEZONE, config.publishWindows);

  for (const platform of targets) {
    await repository.putScheduleEntry({
      jobId: state.jobId,
      platform,
      publishDate: job.publishDate,
      publishAt: scheduledFor.toISOString(),
      status: 'PENDING',
    });
  }

  await repository.updateJob(state.jobId, {
    status: 'SCHEDULED',
    scheduledFor: scheduledFor.toISOString(),
  });
  await repository.appendEvent(state.jobId, {
    at: now.toISOString(),
    type: 'SCHEDULED',
    actor: 'workflow',
    detail: {
      scheduledFor: scheduledFor.toISOString(),
      inWindow,
      publishMode: config.PUBLISH_MODE,
      targets,
      decisions,
    },
  });
  emitMetric(Metrics.jobsScheduled, 1, { Environment: config.ENVIRONMENT });

  return {
    ...base,
    status: 'SCHEDULED',
    decision: inWindow ? 'proceed' : 'deferred',
    scheduledFor: scheduledFor.toISOString(),
    platformDecisions: decisions,
    publishTargets: targets,
  };
};

export const handler = async (state: WorkflowState): Promise<ScheduleResult> =>
  scheduleOrPublish(state);

/** Re-exported so the guard error name stays available to the state machine. */
export { GuardTrippedError };
