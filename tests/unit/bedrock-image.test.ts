import { describe, expect, it } from 'vitest';

import { ConfigurationError, NonRetryableError, RetryableError } from '@mrp/shared';
import {
  BRAND_TEXT_SAFE_AREA,
  BedrockImageGenerator,
  encodePng,
  type BedrockImageBodyStyle,
  type ImageRequest,
} from '@mrp/providers';

/** Stands in for BedrockClient, recording the body the generator built. */
class RecordingClient {
  public lastBody: Record<string, unknown> | undefined;

  public constructor(private readonly response: unknown) {}

  public async invokeModel(_modelId: string, body: unknown): Promise<unknown> {
    this.lastBody = body as Record<string, unknown>;
    return this.response;
  }
}

const reference = {
  data: encodePng(8, 8, new Uint8Array(8 * 8 * 3).fill(200)),
  format: 'png' as const,
  similarityStrength: 0.5,
};

const imageRequest = (overrides: Partial<ImageRequest> = {}): ImageRequest => ({
  jobId: 'job-1',
  sceneConcept: 'a lone figure watching the sunrise from a hilltop',
  textSafeArea: BRAND_TEXT_SAFE_AREA,
  quoteRenderMode: 'overlay',
  seed: 123_456,
  width: 1080,
  height: 1920,
  attempt: 0,
  ...overrides,
});

const generatorFor = (
  bodyStyle: BedrockImageBodyStyle,
  response: unknown,
): { generator: BedrockImageGenerator; client: RecordingClient } => {
  const client = new RecordingClient(response);
  const generator = new BedrockImageGenerator({
    // The fake only needs invokeModel; the real client's surface is larger.
    client: client as never,
    modelId: 'us.stability.stable-image-style-guide-v1:0',
    bodyStyle,
  });
  return { generator, client };
};

const okResponse = (): unknown => ({
  seeds: [123],
  finish_reasons: [null],
  images: [Buffer.from(encodePng(9, 16, new Uint8Array(9 * 16 * 3).fill(180))).toString('base64')],
});

describe('stability_style_guide body', () => {
  it('sends the reference image, an aspect ratio and fidelity', async () => {
    const { generator, client } = generatorFor('stability_style_guide', okResponse());
    await generator.generate(imageRequest({ referenceImage: reference }));

    const body = client.lastBody!;
    expect(body.image).toBe(Buffer.from(reference.data).toString('base64'));
    expect(body.aspect_ratio).toBe('9:16');
    expect(body.fidelity).toBe(0.5);
    expect(body.output_format).toBe('png');
    expect(body.negative_prompt).toEqual(expect.any(String));
    // This model sizes from the ratio; sending pixel dimensions would be wrong.
    expect(body).not.toHaveProperty('width');
    expect(body).not.toHaveProperty('height');
  });

  it('keeps the seed inside the documented range', async () => {
    const { generator, client } = generatorFor('stability_style_guide', okResponse());
    await generator.generate(imageRequest({ referenceImage: reference, seed: 9_000_000_000 }));

    expect(client.lastBody!.seed).toBeLessThanOrEqual(4_294_967_294);
    expect(client.lastBody!.seed).toBeGreaterThanOrEqual(0);
  });

  it('refuses to run without a reference image, because the model requires one', async () => {
    const { generator } = generatorFor('stability_style_guide', okResponse());
    await expect(generator.generate(imageRequest())).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('rejects an aspect ratio the model does not support', async () => {
    const { generator } = generatorFor('stability_style_guide', okResponse());
    await expect(
      generator.generate(imageRequest({ referenceImage: reference, width: 1000, height: 1921 })),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('finish_reasons', () => {
  it('treats a content filter as non-retryable', async () => {
    const { generator } = generatorFor('stability_style_guide', {
      finish_reasons: ['Filter reason: prompt'],
      images: [],
    });
    await expect(
      generator.generate(imageRequest({ referenceImage: reference })),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('treats an inference error as retryable', async () => {
    const { generator } = generatorFor('stability_style_guide', {
      finish_reasons: ['Inference error'],
      images: [],
    });
    await expect(
      generator.generate(imageRequest({ referenceImage: reference })),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('accepts a null reason as success', async () => {
    const { generator } = generatorFor('stability_style_guide', okResponse());
    const result = await generator.generate(imageRequest({ referenceImage: reference }));
    expect(result.width).toBe(9);
    expect(result.height).toBe(16);
  });
});

describe('nova_titan body', () => {
  it('uses IMAGE_VARIATION only when a reference is supplied', async () => {
    const { generator, client } = generatorFor('nova_titan', okResponse());

    await generator.generate(imageRequest());
    expect(client.lastBody!.taskType).toBe('TEXT_IMAGE');

    await generator.generate(imageRequest({ referenceImage: reference }));
    expect(client.lastBody!.taskType).toBe('IMAGE_VARIATION');
  });

  it('asks for exact pixel dimensions, which this family supports', async () => {
    const { generator, client } = generatorFor('nova_titan', okResponse());
    await generator.generate(imageRequest());

    const config = client.lastBody!.imageGenerationConfig as Record<string, number>;
    expect(config.width).toBe(1080);
    expect(config.height).toBe(1920);
  });
});
