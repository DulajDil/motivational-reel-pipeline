import {
  ManualReviewRequiredError,
  Metrics,
  NonRetryableError,
  RetryableError,
  emitMetric,
  publishIdempotencyKey,
  redactPayload,
  s3Keys,
  type ContentMetadata,
  type Job,
  type Platform,
  type RemoteMediaStatusLike,
  type RenderManifest,
  type WorkflowState,
} from '@mrp/shared';

import { getRuntime, type Runtime } from '../context.js';

/**
 * Publishing.
 *
 * One implementation drives both platforms because the workflow shape is the
 * same - create, poll, finalise - even though the underlying Graph flows differ.
 * Instagram and Facebook remain SEPARATE transactions: each has its own publish
 * state row, its own attempt counter and its own success/failure, and neither
 * infers anything from the other.
 *
 * Idempotency at the external boundary:
 *   - the publish row is created once, keyed by (jobId, platform),
 *   - `idempotencyKey` binds it to the exact rendered asset checksum,
 *   - the PENDING -> IN_PROGRESS -> PUBLISHED transitions are conditional writes,
 *     so a duplicate invocation cannot start a second container or publish twice.
 */

export interface PublishBranchState extends WorkflowState {
  platform: Platform;
  containerId?: string;
  pollAttempts?: number;
  containerStatus?: RemoteMediaStatusLike;
  publishSkipped?: boolean;
  skipReason?: string;
  mediaId?: string;
  permalink?: string;
}

type RenderedJob = Job & { render: RenderManifest; content: ContentMetadata };

const loadRenderedJob = async (runtime: Runtime, jobId: string): Promise<RenderedJob> => {
  const job = await runtime.repository.getJob(jobId);
  if (!job?.render) throw new NonRetryableError(`Job ${jobId} has no rendered asset`);
  if (!job.content) throw new NonRetryableError(`Job ${jobId} has no caption content`);
  return job as RenderedJob;
};

const captionFor = (caption: string, hashtags: string[]): string =>
  hashtags.length > 0 ? `${caption}\n\n${hashtags.map((tag) => `#${tag}`).join(' ')}` : caption;

/** Phase 1: create the Instagram container / open the Facebook upload session. */
export const createPublishContainer = async (
  state: PublishBranchState,
  runtime: Runtime = getRuntime(),
): Promise<PublishBranchState> => {
  const { config, repository, store, logger } = runtime;
  const platform = state.platform;
  const log = logger.child({ jobId: state.jobId, platform, state: 'CreateContainer' });

  // Both publish branches exist in the state machine; a disabled platform is
  // skipped here rather than by branching the machine on configuration.
  if (!config.ENABLED_PLATFORMS.includes(platform)) {
    return { ...state, publishSkipped: true, skipReason: 'platform_disabled' };
  }

  const job = await loadRenderedJob(runtime, state.jobId);
  const existing = await repository.getPublishState(state.jobId, platform);

  if (existing?.status === 'PUBLISHED') {
    log.info('Already published to this platform; not creating another container');
    return {
      ...state,
      publishSkipped: true,
      skipReason: 'already_published',
      mediaId: existing.mediaId,
      permalink: existing.permalink,
    };
  }

  if (existing && existing.attempts >= config.MAX_PUBLISH_ATTEMPTS) {
    throw new ManualReviewRequiredError(
      `Publish attempts exhausted for ${platform}`,
      'publish_attempts_exhausted',
      { context: { attempts: existing.attempts } },
    );
  }

  const publisher = await runtime.publisherFor(platform);

  // Instagram enforces a rolling publishing quota. Check it BEFORE burning a
  // container, because a rejected container still counts as work.
  if (platform === 'instagram') {
    const quota = await publisher.checkQuota();
    emitMetric(Metrics.quotaRemaining, quota.supported ? quota.remaining : -1, {
      Environment: config.ENVIRONMENT,
      Platform: platform,
    });
    if (quota.supported && quota.remaining <= 0) {
      await repository.transitionPublishState(state.jobId, platform, ['PENDING', 'RETRYABLE'], {
        status: 'RETRYABLE',
        lastErrorCode: 'IG_QUOTA_EXHAUSTED',
        lastErrorMessage: 'Instagram publishing quota exhausted for the current window',
      });
      return { ...state, publishSkipped: true, skipReason: 'instagram_quota_exhausted' };
    }
  }

  const transitioned = await repository.transitionPublishState(
    state.jobId,
    platform,
    ['PENDING', 'RETRYABLE'],
    {
      status: 'IN_PROGRESS',
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttemptAt: runtime.clock().toISOString(),
    },
  );
  if (!transitioned) {
    // Another execution owns this publish. Do not race it.
    log.warn('Publish state is not claimable; another execution owns it');
    return { ...state, publishSkipped: true, skipReason: 'not_claimable' };
  }

  const videoUrl = await store.presignGet(
    job.render.output.key,
    config.PRESIGNED_URL_TTL_SECONDS,
  );
  const thumbnailUrl = await store.presignGet(
    job.render.thumbnail.key,
    config.PRESIGNED_URL_TTL_SECONDS,
  );

  const request = {
    jobId: state.jobId,
    videoUrl,
    thumbnailUrl,
    caption: captionFor(job.content.caption, job.content.hashtags),
    shareToFeed: config.INSTAGRAM_SHARE_TO_FEED,
    idempotencyKey: publishIdempotencyKey(
      state.jobId,
      platform,
      job.render.outputChecksumSha256,
    ),
  };

  const { containerId, detail } = await publisher.createContainer(request);

  await repository.transitionPublishState(state.jobId, platform, ['IN_PROGRESS'], {
    status: 'IN_PROGRESS',
    ...(platform === 'instagram' ? { containerId } : { uploadSessionId: containerId }),
  });
  await repository.appendEvent(state.jobId, {
    at: runtime.clock().toISOString(),
    type: 'PUBLISH_CONTAINER_CREATED',
    actor: 'workflow',
    detail: { platform, containerId, live: publisher.live, response: redactPayload(detail) },
  });

  log.info('Publish container created', { containerId, live: publisher.live });
  return { ...state, containerId, pollAttempts: 0, status: 'PUBLISHING' };
};

/** Phase 2: poll. Called from a bounded Wait/Choice loop in the state machine. */
export const checkPublishStatus = async (
  state: PublishBranchState,
  runtime: Runtime = getRuntime(),
): Promise<PublishBranchState> => {
  const { config, repository, logger } = runtime;
  const platform = state.platform;
  const log = logger.child({ jobId: state.jobId, platform, state: 'CheckStatus' });

  if (state.publishSkipped) return state;
  if (!state.containerId) throw new NonRetryableError('No container id to poll');

  const pollAttempts = (state.pollAttempts ?? 0) + 1;
  const publisher = await runtime.publisherFor(platform);
  const status = await publisher.getContainerStatus(state.containerId);

  log.info('Container status', { status: status.status, pollAttempts });

  if (status.status === 'EXPIRED') {
    // The container died before we could publish. Reset to a safe state so the
    // workflow can create a fresh one instead of retrying a dead id.
    await repository.transitionPublishState(state.jobId, platform, ['IN_PROGRESS'], {
      status: 'RETRYABLE',
      lastErrorCode: 'CONTAINER_EXPIRED',
      lastErrorMessage: 'Publish container expired before publish',
      containerId: '',
    });
    await repository.appendEvent(state.jobId, {
      at: runtime.clock().toISOString(),
      type: 'PUBLISH_CONTAINER_EXPIRED',
      actor: 'workflow',
      detail: { platform, containerId: state.containerId, pollAttempts },
    });
    return { ...state, containerStatus: 'EXPIRED', containerId: undefined, pollAttempts: 0 };
  }

  if (status.status === 'ERROR') {
    await repository.transitionPublishState(state.jobId, platform, ['IN_PROGRESS'], {
      status: 'RETRYABLE',
      lastErrorCode: 'CONTAINER_ERROR',
      lastErrorMessage: status.errorMessage ?? 'Container reported ERROR',
    });
    throw new RetryableError(`${platform} container reported ERROR`, {
      code: 'CONTAINER_ERROR',
      context: { detail: redactPayload(status.detail) },
    });
  }

  if (status.status === 'IN_PROGRESS' && pollAttempts >= config.MAX_CONTAINER_POLL_ATTEMPTS) {
    await repository.transitionPublishState(state.jobId, platform, ['IN_PROGRESS'], {
      status: 'RETRYABLE',
      lastErrorCode: 'CONTAINER_POLL_TIMEOUT',
      lastErrorMessage: `Still processing after ${pollAttempts} polls`,
    });
    throw new ManualReviewRequiredError(
      `${platform} container did not finish within ${pollAttempts} polls`,
      'container_poll_timeout',
    );
  }

  return { ...state, containerStatus: status.status, pollAttempts };
};

/** Phase 3: publish. Only reached after a FINISHED status. */
export const finalisePublish = async (
  state: PublishBranchState,
  runtime: Runtime = getRuntime(),
): Promise<PublishBranchState> => {
  const { config, repository, store, logger } = runtime;
  const platform = state.platform;
  const log = logger.child({ jobId: state.jobId, platform, state: 'Finalise' });

  if (state.publishSkipped) return state;
  if (!state.containerId) throw new NonRetryableError('No container id to publish');

  const job = await loadRenderedJob(runtime, state.jobId);
  const publisher = await runtime.publisherFor(platform);

  const request = {
    jobId: state.jobId,
    videoUrl: '',
    caption: captionFor(job.content.caption, job.content.hashtags),
    idempotencyKey: publishIdempotencyKey(
      state.jobId,
      platform,
      job.render.outputChecksumSha256,
    ),
  };

  const outcome = await publisher.publishContainer(state.containerId, request);
  const at = runtime.clock().toISOString();

  const committed = await repository.transitionPublishState(state.jobId, platform, ['IN_PROGRESS'], {
    status: 'PUBLISHED',
    mediaId: outcome.mediaId,
    permalink: outcome.permalink,
    publishedAt: at,
  });
  if (!committed) {
    // The row moved underneath us. The post may well have gone out, so this is a
    // human decision, not an automatic retry.
    throw new ManualReviewRequiredError(
      `Published to ${platform} but could not commit the publish state`,
      'publish_state_commit_failed',
      { context: { mediaId: outcome.mediaId } },
    );
  }

  await store.put({
    key: s3Keys.publishReceipt(state.jobId, platform),
    body: new TextEncoder().encode(
      JSON.stringify(
        {
          jobId: state.jobId,
          platform,
          live: publisher.live,
          mediaId: outcome.mediaId,
          permalink: outcome.permalink,
          containerId: state.containerId,
          assetChecksum: job.render.outputChecksumSha256,
          publishedAt: at,
          response: redactPayload(outcome.detail),
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });

  await repository.appendEvent(state.jobId, {
    at,
    type: 'PUBLISHED',
    actor: 'workflow',
    detail: {
      platform,
      mediaId: outcome.mediaId,
      permalink: outcome.permalink,
      live: publisher.live,
    },
  });

  emitMetric(Metrics.publishSucceeded, 1, { Environment: config.ENVIRONMENT, Platform: platform });
  log.info('Published', { mediaId: outcome.mediaId, live: publisher.live });

  return {
    ...state,
    status: 'PUBLISHING',
    mediaId: outcome.mediaId,
    permalink: outcome.permalink,
  };
};

/** Catch handler for a publish branch: records the failure without failing the job. */
export const recordPublishFailure = async (
  state: PublishBranchState & { error?: { Error?: string; Cause?: string } },
  runtime: Runtime = getRuntime(),
): Promise<PublishBranchState> => {
  const { config, repository, logger } = runtime;
  const platform = state.platform;

  const errorName = state.error?.Error ?? 'UnknownError';
  const terminal = errorName === 'NonRetryableError' || errorName === 'ConfigurationError';

  await repository.transitionPublishState(
    state.jobId,
    platform,
    ['PENDING', 'IN_PROGRESS', 'RETRYABLE'],
    {
      status: terminal ? 'FAILED' : 'RETRYABLE',
      lastErrorCode: errorName,
      lastErrorMessage: (state.error?.Cause ?? '').slice(0, 500),
    },
  );
  await repository.appendEvent(state.jobId, {
    at: runtime.clock().toISOString(),
    type: 'PUBLISH_FAILED',
    actor: 'workflow',
    detail: { platform, errorName, terminal },
  });

  emitMetric(Metrics.publishFailed, 1, { Environment: config.ENVIRONMENT, Platform: platform });
  logger.error('Publish branch failed', { jobId: state.jobId, platform, errorName, terminal });

  return { ...state, publishSkipped: true, skipReason: errorName };
};
