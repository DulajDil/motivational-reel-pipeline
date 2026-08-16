import { NonRetryableError, RetryableError, redactPayload } from '@mrp/shared';

import { IMAGE_NEGATIVE_PROMPT, PROMPT_VERSIONS, buildImagePrompt } from '../prompts.js';
import type { GeneratedImage, ImageGenerator, ImageRequest } from '../types.js';
import { readImageDimensions } from './png.js';

/**
 * OpenAI Images provider.
 *
 * This is the one component that talks to a vendor outside AWS. It exists
 * because gpt-image produces this project's house style directly, which no
 * Bedrock image model was able to match - see docs/decisions.md #14.
 *
 * Two properties of the Images API shape this implementation:
 *
 *   - There is NO negative_prompt parameter, unlike every Bedrock image model.
 *     The exclusions are folded into the prompt text instead, so the reserved
 *     area is still defended in words even though the renderer draws the quote
 *     regardless.
 *   - Sizes must have both edges divisible by 16, so the exact 1080x1920 frame
 *     cannot be requested. A larger true 9:16 size is generated and the renderer
 *     scales it down, which is preferable to scaling up.
 *
 * The API key is fetched lazily through a resolver rather than held on the
 * instance at construction, so the provider factory can stay synchronous and the
 * key is never read on a code path that does not generate an image.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com';

/** Retried by the caller's bounded loop; anything else is fatal for this job. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface OpenAIImageGeneratorOptions {
  /** Resolved on first use so the factory need not be async. */
  apiKey: () => Promise<string>;
  modelId: string;
  /** WIDTHxHEIGHT, both edges divisible by 16. Validated in loadConfig. */
  size: string;
  quality?: 'auto' | 'low' | 'medium' | 'high';
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
}

interface ImagesResponse {
  data?: { b64_json?: unknown }[];
}

/**
 * The Images API has no negative_prompt, so the exclusions become a sentence.
 * Kept adjacent to the prompt builder's own wording rather than duplicated.
 */
const withExclusions = (prompt: string): string =>
  `${prompt}\nDo not include any of the following: ${IMAGE_NEGATIVE_PROMPT}.`;

const describeFailure = async (response: Response): Promise<string> => {
  // Error bodies can echo the prompt; they are redacted before they go anywhere.
  const body = await response.text().catch(() => '');
  const detail = redactPayload(body.slice(0, 500));
  return `OpenAI Images returned ${response.status}: ${String(detail)}`;
};

export class OpenAIImageGenerator implements ImageGenerator {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: OpenAIImageGeneratorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Reference frames go to /v1/images/edits, which accepts them as style input.
   * Without one, plain /v1/images/generations is used and the house style rests
   * on the prompt alone.
   */
  private buildRequest(prompt: string, request: ImageRequest): { url: string; form: FormData } {
    const form = new FormData();
    form.append('model', this.options.modelId);
    form.append('prompt', withExclusions(prompt));
    form.append('size', this.options.size);
    form.append('quality', this.options.quality ?? 'high');
    form.append('n', '1');
    form.append('output_format', 'png');

    const reference = request.referenceImage;
    if (!reference) {
      return { url: `${this.options.baseUrl ?? DEFAULT_BASE_URL}/v1/images/generations`, form };
    }

    const mime = reference.format === 'png' ? 'image/png' : 'image/jpeg';
    form.append(
      'image[]',
      new Blob([Buffer.from(reference.data)], { type: mime }),
      `reference.${reference.format}`,
    );
    return { url: `${this.options.baseUrl ?? DEFAULT_BASE_URL}/v1/images/edits`, form };
  }

  public async generate(request: ImageRequest): Promise<GeneratedImage> {
    const prompt = buildImagePrompt({
      sceneConcept: request.sceneConcept,
      textSafeArea: request.textSafeArea,
      quoteRenderMode: request.quoteRenderMode,
      hasReferenceImage: request.referenceImage !== undefined,
    });

    const { url, form } = this.buildRequest(prompt, request);
    const apiKey = await this.options.apiKey();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        // The key travels in the header only: never in the URL, never logged.
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } catch (error) {
      throw new RetryableError('OpenAI Images request failed to complete', { cause: error });
    }

    if (!response.ok) {
      const message = await describeFailure(response);
      if (RETRYABLE_STATUS.has(response.status)) throw new RetryableError(message);
      throw new NonRetryableError(message, { code: `OPENAI_HTTP_${response.status}` });
    }

    const payload = (await response.json()) as ImagesResponse;
    const base64 = payload.data?.[0]?.b64_json;
    if (typeof base64 !== 'string' || base64.length === 0) {
      throw new RetryableError('OpenAI Images response contained no image payload');
    }

    const data = new Uint8Array(Buffer.from(base64, 'base64'));
    let dimensions;
    try {
      dimensions = readImageDimensions(data);
    } catch (error) {
      throw new NonRetryableError('OpenAI returned an image in an unsupported format', {
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
      // Only the metadata is kept for audit; the base64 payload is the image
      // object itself and is stored separately.
      rawResponse: { model: this.options.modelId, size: this.options.size, images: '[STRIPPED]' },
      provider: 'openai',
      modelId: this.options.modelId,
      promptVersion: PROMPT_VERSIONS.image,
    };
  }
}
