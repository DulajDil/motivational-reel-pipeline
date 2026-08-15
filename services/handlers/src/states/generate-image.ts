import {
  Metrics,
  NonRetryableError,
  emitMetric,
  redactPayload,
  renderSeed,
  s3Keys,
  type ImageAsset,
  type WorkflowState,
} from '@mrp/shared';

import { getRuntime, type Runtime } from '../context.js';

/**
 * GenerateImage.
 *
 * Produces the illustration for the current attempt and stores two objects:
 * the redacted raw provider response (for audit) and the normalised image bytes.
 * Provider credentials never appear in either, nor in any log line - the
 * response passes through `redactPayload` before it is written anywhere.
 */
export const generateImage = async (
  state: WorkflowState,
  runtime: Runtime = getRuntime(),
): Promise<WorkflowState> => {
  const { config, repository, providers, store, logger } = runtime;
  const attempt = state.generationAttempts ?? 0;
  const log = logger.child({ jobId: state.jobId, state: 'GenerateImage', attempt });

  const job = await repository.getJob(state.jobId);
  if (!job) throw new NonRetryableError(`Job ${state.jobId} not found`);
  if (!job.content) throw new NonRetryableError(`Job ${state.jobId} has no content to illustrate`);

  const generated = await providers.image.generate({
    jobId: state.jobId,
    sceneConcept: job.content.sceneConcept,
    textSafeArea: job.content.textSafeArea,
    quoteRenderMode: config.QUOTE_RENDER_MODE,
    quote: config.QUOTE_RENDER_MODE === 'overlay' ? undefined : job.content.quote.text,
    seed: renderSeed(state.jobId),
    width: 1080,
    height: 1920,
    attempt,
  });

  await store.put({
    key: s3Keys.rawImage(state.jobId, attempt),
    body: new TextEncoder().encode(
      JSON.stringify(
        {
          provider: generated.provider,
          modelId: generated.modelId,
          promptVersion: generated.promptVersion,
          prompt: generated.prompt,
          negativePrompt: generated.negativePrompt,
          response: redactPayload(generated.rawResponse),
        },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });

  const stored = await store.put({
    key: s3Keys.image(state.jobId, attempt),
    body: generated.data,
    contentType: generated.format === 'png' ? 'image/png' : 'image/jpeg',
    metadata: { jobid: state.jobId, attempt: String(attempt) },
  });

  const image: ImageAsset = {
    ...stored,
    width: generated.width,
    height: generated.height,
    format: generated.format,
  };

  await repository.updateJob(state.jobId, { image, generationAttempts: attempt });
  await repository.appendEvent(state.jobId, {
    at: runtime.clock().toISOString(),
    type: 'IMAGE_GENERATED',
    actor: 'workflow',
    detail: {
      attempt,
      provider: generated.provider,
      modelId: generated.modelId,
      promptVersion: generated.promptVersion,
      key: stored.key,
      bytes: stored.sizeBytes,
    },
  });

  emitMetric(Metrics.imagesGenerated, 1, { Environment: config.ENVIRONMENT });
  log.info('Image generated', { key: stored.key, bytes: stored.sizeBytes });

  return { ...state, generationAttempts: attempt };
};

export const handler = async (state: WorkflowState): Promise<WorkflowState> => generateImage(state);
