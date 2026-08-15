import { NonRetryableError, RetryableError, redactPayload } from '@mrp/shared';

import type { BedrockClient } from '../bedrock-client.js';
import { IMAGE_NEGATIVE_PROMPT, PROMPT_VERSIONS, buildImagePrompt } from '../prompts.js';
import type { GeneratedImage, ImageGenerator, ImageRequest } from '../types.js';
import { readImageDimensions } from './png.js';

/**
 * Bedrock image generation.
 *
 * Image model request bodies are not standardised the way Converse standardises
 * text, so the body is built from a small, declared shape rather than from a
 * hardcoded model family. `BEDROCK_IMAGE_BODY_STYLE` selects the shape; the
 * default covers the common `{ textToImageParams, imageGenerationConfig }` form
 * and the common `{ text_prompts, cfg_scale }` form is available as an option.
 *
 * Verify which shape your enabled model expects before switching PROVIDER_MODE
 * to `bedrock` - see docs/operations.md.
 */
export type BedrockImageBodyStyle = 'nova_titan' | 'stability';

export interface BedrockImageGeneratorOptions {
  client: BedrockClient;
  modelId: string;
  bodyStyle?: BedrockImageBodyStyle;
}

interface DecodedImage {
  base64: string;
}

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
    });

    const response = await this.options.client.invokeModel(
      this.options.modelId,
      this.buildBody(prompt, request),
    );

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
