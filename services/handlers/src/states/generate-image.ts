import {
  Metrics,
  NonRetryableError,
  emitMetric,
  parseS3Uri,
  redactPayload,
  renderSeed,
  s3Keys,
  type ImageAsset,
  type WorkflowState,
} from '@mrp/shared';
import type { ReferenceImage } from '@mrp/providers';

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

  // The approved brand reference frame keeps every Reel in the same visual
  // series. It is optional: without it the prompt alone drives the style.
  let referenceImage: ReferenceImage | undefined;
  if (config.REFERENCE_IMAGE_S3_URI) {
    const { bucket, key } = parseS3Uri(config.REFERENCE_IMAGE_S3_URI);
    if (bucket !== store.bucket) {
      throw new NonRetryableError(
        `REFERENCE_IMAGE_S3_URI points at bucket "${bucket}" but this function is scoped to "${store.bucket}".`,
        { code: 'REFERENCE_IMAGE_BUCKET_MISMATCH' },
      );
    }
    referenceImage = {
      data: await store.get(key),
      format: key.toLowerCase().endsWith('.jpg') || key.toLowerCase().endsWith('.jpeg')
        ? 'jpeg'
        : 'png',
      similarityStrength: config.REFERENCE_SIMILARITY_STRENGTH,
    };
  }

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
    referenceImage,
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
      usedReferenceImage: referenceImage !== undefined,
    },
  });

  emitMetric(Metrics.imagesGenerated, 1, { Environment: config.ENVIRONMENT });
  log.info('Image generated', { key: stored.key, bytes: stored.sizeBytes });

  return { ...state, generationAttempts: attempt };
};

// No Lambda entry point: this step runs inside PrepareContent.
