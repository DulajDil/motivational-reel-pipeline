import {
  ManualReviewRequiredError,
  Metrics,
  NonRetryableError,
  emitMetric,
  type WorkflowState,
} from '@mrp/shared';

import { getRuntime, type Runtime } from '../context.js';

export interface ValidateImageResult extends WorkflowState {
  imageValid: boolean;
  imageFailures: string[];
}

/**
 * ValidateImage.
 *
 * Rejects an image rather than letting a bad frame reach a publish. In
 * overlay/hybrid mode any substantial accidental text inside the reserved area
 * is fatal, because the drawn quote would collide with it.
 *
 * The outcome is returned as data (`imageValid`) so the state machine's Choice
 * owns the bounded regeneration loop. Only when the attempt budget is exhausted
 * does this throw, and then it throws `ManualReviewRequiredError` so the job is
 * parked for a human instead of retried forever.
 */
export const validateImage = async (
  state: WorkflowState,
  runtime: Runtime = getRuntime(),
): Promise<ValidateImageResult> => {
  const { config, repository, providers, store, logger } = runtime;
  const attempt = state.generationAttempts ?? 0;
  const log = logger.child({ jobId: state.jobId, state: 'ValidateImage', attempt });

  const job = await repository.getJob(state.jobId);
  if (!job) throw new NonRetryableError(`Job ${state.jobId} not found`);
  if (!job.image || !job.content) {
    throw new NonRetryableError(`Job ${state.jobId} has no image to validate`);
  }

  const bytes = await store.get(job.image.key);
  const report = await providers.validator.validate({
    jobId: state.jobId,
    image: {
      data: bytes,
      format: job.image.format,
      width: job.image.width,
      height: job.image.height,
    },
    textSafeArea: job.content.textSafeArea,
    quoteRenderMode: config.QUOTE_RENDER_MODE,
    expectedWidth: 1080,
    expectedHeight: 1920,
  });

  await repository.updateJob(state.jobId, {
    imageValidation: report,
    ...(report.passed ? { status: 'IMAGE_READY' as const } : {}),
  });
  await repository.appendEvent(state.jobId, {
    at: runtime.clock().toISOString(),
    type: report.passed ? 'IMAGE_VALIDATED' : 'IMAGE_REJECTED',
    actor: 'workflow',
    detail: { attempt, failures: report.failures, moderation: report.moderationLabels },
  });

  if (report.passed) {
    log.info('Image accepted');
    return { ...state, status: 'IMAGE_READY', imageValid: true, imageFailures: [] };
  }

  emitMetric(Metrics.imagesRejected, 1, {
    Environment: config.ENVIRONMENT,
    Reason: report.failures[0] ?? 'unknown',
  });
  log.warn('Image rejected', { failures: report.failures });

  const nextAttempt = attempt + 1;
  if (nextAttempt >= config.MAX_GENERATION_ATTEMPTS) {
    throw new ManualReviewRequiredError(
      `Image validation failed ${nextAttempt} times`,
      'image_validation_exhausted',
      { context: { failures: report.failures } },
    );
  }

  return {
    ...state,
    imageValid: false,
    imageFailures: report.failures,
    generationAttempts: nextAttempt,
  };
};

export const handler = async (state: WorkflowState): Promise<ValidateImageResult> =>
  validateImage(state);
