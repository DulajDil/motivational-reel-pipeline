import { ConfigurationError, NonRetryableError, RetryableError, redactPayload } from '@mrp/shared';

import type { BedrockClient } from '../bedrock-client.js';
import { IMAGE_NEGATIVE_PROMPT, PROMPT_VERSIONS, buildImagePrompt } from '../prompts.js';
import type { GeneratedImage, ImageGenerator, ImageRequest } from '../types.js';
import { readImageDimensions } from './png.js';

/**
 * Bedrock image generation.
 *
 * Image model request bodies are not standardised the way Converse standardises
 * text, so the body is built from a small, declared shape rather than from a
 * hardcoded model family. `BEDROCK_IMAGE_BODY_STYLE` selects the shape:
 *
 *   nova_titan            `{ textToImageParams, imageGenerationConfig }`, and
 *                         IMAGE_VARIATION when a reference frame is configured.
 *   stability             the SDXL-era `{ text_prompts, cfg_scale }` form.
 *   stability_style_guide Stability Image Services Style Guide, which draws a
 *                         new scene in a reference frame's style and therefore
 *                         REQUIRES that reference. Sizes its output from an
 *                         aspect ratio, not from explicit pixel dimensions.
 *
 * Verify which shape your enabled model expects before switching PROVIDER_MODE
 * to `bedrock` - see docs/operations.md.
 */
export type BedrockImageBodyStyle = 'nova_titan' | 'stability' | 'stability_style_guide';

/** Stability Image Services accept only this fixed set of aspect ratios. */
const STABILITY_ASPECT_RATIOS = new Set([
  '16:9',
  '1:1',
  '21:9',
  '2:3',
  '3:2',
  '4:5',
  '5:4',
  '9:16',
  '9:21',
]);

const greatestCommonDivisor = (a: number, b: number): number =>
  b === 0 ? a : greatestCommonDivisor(b, a % b);

/**
 * Stability Image Services size their output from an aspect-ratio enum rather
 * than explicit pixels, so the requested width and height are reduced to a
 * ratio. The renderer scales the result to the exact frame size.
 */
const toStabilityAspectRatio = (width: number, height: number): string => {
  const divisor = greatestCommonDivisor(width, height);
  const ratio = `${width / divisor}:${height / divisor}`;
  if (!STABILITY_ASPECT_RATIOS.has(ratio)) {
    throw new ConfigurationError(
      `Stability Image Services do not support a ${width}x${height} (${ratio}) aspect ratio.`,
    );
  }
  return ratio;
};

export interface BedrockImageGeneratorOptions {
  client: BedrockClient;
  modelId: string;
  bodyStyle?: BedrockImageBodyStyle;
}

interface DecodedImage {
  base64: string;
}

/**
 * Stability Image Services report content filtering in `finish_reasons` with a
 * 200 response and no usable image, so a null-ish reason has to be treated as an
 * error rather than read as success. A filtered prompt will be filtered again
 * on every retry, so it is not retryable; an inference error is.
 */
const assertNotFiltered = (response: unknown): void => {
  const reasons = (response as Record<string, unknown>)?.finish_reasons;
  if (!Array.isArray(reasons)) return;

  const reason = reasons.find((entry): entry is string => typeof entry === 'string');
  if (reason === undefined) return;

  if (reason.startsWith('Filter reason')) {
    throw new NonRetryableError(`Image generation was content-filtered: ${reason}`, {
      code: 'IMAGE_CONTENT_FILTERED',
    });
  }
  throw new RetryableError(`Image generation did not finish cleanly: ${reason}`);
};

const findBase64Image = (response: unknown): DecodedImage => {
  const record = response as Record<string, unknown>;
  const images = record?.images;
  if (Array.isArray(images) && typeof images[0] === 'string') {
    return { base64: images[0] };
  }
  const artifacts = record?.artifacts;
  if (Array.isArray(artifacts)) {
    const first = artifacts[0] as { base64?: unknown } | undefined;
    if (typeof first?.base64 === 'string') return { base64: first.base64 };
  }
  throw new RetryableError('Bedrock image response contained no image payload', {
    context: { response: redactPayload(response, 500) },
  });
};

export class BedrockImageGenerator implements ImageGenerator {
  public constructor(private readonly options: BedrockImageGeneratorOptions) {}

  private buildBody(prompt: string, request: ImageRequest): unknown {
    const style = this.options.bodyStyle ?? 'nova_titan';
    const reference = request.referenceImage;

    if (style === 'stability_style_guide') {
      /*
       * Stability Style Guide extracts the style of a reference frame and draws
       * a new scene in it, which is exactly the brand-consistency requirement.
       * The reference is a REQUIRED parameter of this model, so there is no
       * prompt-only fallback: without one, the configuration is wrong.
       */
      if (!reference) {
        throw new ConfigurationError(
          'BEDROCK_IMAGE_BODY_STYLE=stability_style_guide requires REFERENCE_IMAGE_S3_URI; the model takes the reference image as a required parameter.',
        );
      }
      return {
        prompt,
        negative_prompt: IMAGE_NEGATIVE_PROMPT,
        image: Buffer.from(reference.data).toString('base64'),
        aspect_ratio: toStabilityAspectRatio(request.width, request.height),
        // How closely the output's style follows the reference. 0..1, default 0.5.
        fidelity: reference.similarityStrength,
        seed: request.seed % 4_294_967_294,
        output_format: 'png',
      };
    }

    if (style === 'nova_titan' && reference) {
      /*
       * Style-consistent generation: the approved reference frame is passed as
       * an image variation source with a moderate similarity strength, so the
       * model keeps the paper, linework and palette while the text prompt
       * drives the new scene.
       *
       * NOTE: image-conditioning parameter names and semantics differ between
       * image model families, and a high similarityStrength will reproduce the
       * reference rather than restyle a new scene. Validate the output before
       * enabling this in production - see docs/brand-consistency.md.
       */
      return {
        taskType: 'IMAGE_VARIATION',
        imageVariationParams: {
          text: prompt,
          negativeText: IMAGE_NEGATIVE_PROMPT,
          images: [Buffer.from(reference.data).toString('base64')],
          similarityStrength: reference.similarityStrength,
        },
        imageGenerationConfig: {
          numberOfImages: 1,
          width: request.width,
          height: request.height,
          cfgScale: 7,
          seed: request.seed % 2_147_483_647,
        },
      };
    }

    if (style === 'stability') {
      return {
        text_prompts: [
          { text: prompt, weight: 1 },
          { text: IMAGE_NEGATIVE_PROMPT, weight: -1 },
        ],
        width: request.width,
        height: request.height,
        cfg_scale: 7,
        seed: request.seed,
        steps: 40,
      };
    }
    return {
      taskType: 'TEXT_IMAGE',
      textToImageParams: { text: prompt, negativeText: IMAGE_NEGATIVE_PROMPT },
      imageGenerationConfig: {
        numberOfImages: 1,
        width: request.width,
        height: request.height,
        cfgScale: 7,
        seed: request.seed % 2_147_483_647,
      },
    };
  }

  public async generate(request: ImageRequest): Promise<GeneratedImage> {
    const prompt = buildImagePrompt({
      sceneConcept: request.sceneConcept,
      textSafeArea: request.textSafeArea,
      quoteRenderMode: request.quoteRenderMode,
      hasReferenceImage: request.referenceImage !== undefined,
    });

    const response = await this.options.client.invokeModel(
      this.options.modelId,
      this.buildBody(prompt, request),
    );

    assertNotFiltered(response);
    const { base64 } = findBase64Image(response);
    const data = new Uint8Array(Buffer.from(base64, 'base64'));
    if (data.byteLength === 0) {
      throw new RetryableError('Bedrock returned a zero-length image');
    }

    let dimensions;
    try {
      dimensions = readImageDimensions(data);
    } catch (error) {
      throw new NonRetryableError('Bedrock returned an image in an unsupported format', {
        cause: error,
      });
    }

    return {
      data,
      format: dimensions.format,
      width: dimensions.width,
      height: dimensions.height,
      prompt,
      negativePrompt: IMAGE_NEGATIVE_PROMPT,
      // Base64 payload is stripped: the raw response is persisted for audit, the
      // bytes are persisted separately as the image object.
      rawResponse: redactPayload({ ...(response as object), images: '[STRIPPED]', artifacts: '[STRIPPED]' }),
      provider: 'bedrock',
      modelId: this.options.modelId,
      promptVersion: PROMPT_VERSIONS.image,
    };
  }
}
