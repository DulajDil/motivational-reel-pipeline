import { IMAGE_NEGATIVE_PROMPT, PROMPT_VERSIONS, buildImagePrompt } from '../prompts.js';
import type { GeneratedImage, ImageGenerator, ImageRequest } from '../types.js';
import { renderProceduralSketch } from './procedural-sketch.js';

/**
 * Mock image provider: deterministic, offline, correctly sized.
 *
 * `failFirstAttempts` lets tests drive the bounded-regeneration path without a
 * real model, by producing an under-sized image on the first N attempts.
 */
export class MockImageGenerator implements ImageGenerator {
  public constructor(
    private readonly options: { modelId?: string; failFirstAttempts?: number } = {},
  ) {}

  public async generate(request: ImageRequest): Promise<GeneratedImage> {
    const shouldFail = request.attempt < (this.options.failFirstAttempts ?? 0);
    const width = shouldFail ? Math.floor(request.width / 2) : request.width;
    const height = shouldFail ? Math.floor(request.height / 2) : request.height;

    const data = renderProceduralSketch({
      width,
      height,
      seed: request.seed + request.attempt,
      textSafeArea: request.textSafeArea,
    });

    const prompt = buildImagePrompt({
      sceneConcept: request.sceneConcept,
      textSafeArea: request.textSafeArea,
      quoteRenderMode: request.quoteRenderMode,
      hasReferenceImage: request.referenceImage !== undefined,
    });

    return {
      data,
      format: 'png',
      width,
      height,
      prompt,
      negativePrompt: IMAGE_NEGATIVE_PROMPT,
      rawResponse: { provider: 'mock', bytes: data.byteLength, deterministic: true },
      provider: 'mock',
      modelId: this.options.modelId ?? 'mock-image-v1',
      promptVersion: PROMPT_VERSIONS.image,
    };
  }
}
