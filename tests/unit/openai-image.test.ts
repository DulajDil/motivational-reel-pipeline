import { describe, expect, it } from 'vitest';

import { NonRetryableError, RetryableError } from '@mrp/shared';
import {
  BRAND_TEXT_SAFE_AREA,
  OpenAIImageGenerator,
  encodePng,
  type ImageRequest,
} from '@mrp/providers';

const pngBase64 = (width: number, height: number): string =>
  Buffer.from(encodePng(width, height, new Uint8Array(width * height * 3).fill(190))).toString(
    'base64',
  );

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

interface Captured {
  url: string;
  headers: Record<string, string>;
  form: FormData;
}

const generatorWith = (
  respond: () => Response,
): { generator: OpenAIImageGenerator; calls: Captured[] } => {
  const calls: Captured[] = [];
  const generator = new OpenAIImageGenerator({
    apiKey: async () => 'sk-test-key-not-real-000000000000',
    modelId: 'gpt-image-2',
    size: '1152x2048',
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        form: init.body as FormData,
      });
      return respond();
    }) as unknown as typeof fetch,
  });
  return { generator, calls };
};

const okResponse = (width = 1152, height = 2048): Response =>
  new Response(JSON.stringify({ data: [{ b64_json: pngBase64(width, height) }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('OpenAIImageGenerator', () => {
  it('sends the reference frame to the edits endpoint', async () => {
    const { generator, calls } = generatorWith(() => okResponse());
    await generator.generate(imageRequest({ referenceImage: reference }));

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/edits');
    expect(calls[0]!.form.get('image[]')).toBeInstanceOf(Blob);
    expect(calls[0]!.form.get('model')).toBe('gpt-image-2');
    expect(calls[0]!.form.get('size')).toBe('1152x2048');
  });

  it('falls back to the generations endpoint without a reference', async () => {
    const { generator, calls } = generatorWith(() => okResponse());
    await generator.generate(imageRequest());

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    expect(calls[0]!.form.get('image[]')).toBeNull();
  });

  it('carries the key in the Authorization header and nowhere else', async () => {
    const { generator, calls } = generatorWith(() => okResponse());
    await generator.generate(imageRequest({ referenceImage: reference }));

    expect(calls[0]!.headers.Authorization).toBe('Bearer sk-test-key-not-real-000000000000');
    expect(calls[0]!.url).not.toContain('sk-test');
    // The prompt is the only free-text field; the key must never reach it.
    expect(String(calls[0]!.form.get('prompt'))).not.toContain('sk-test');
  });

  it('folds the exclusions into the prompt, since the API has no negative_prompt', async () => {
    const { generator, calls } = generatorWith(() => okResponse());
    await generator.generate(imageRequest());

    const prompt = String(calls[0]!.form.get('prompt'));
    expect(calls[0]!.form.get('negative_prompt')).toBeNull();
    expect(prompt).toContain('Do not include any of the following:');
    expect(prompt).toContain('watermark');
  });

  it('reports the true generated dimensions, not the requested frame size', async () => {
    const { generator } = generatorWith(() => okResponse(1152, 2048));
    const result = await generator.generate(imageRequest());

    expect(result.width).toBe(1152);
    expect(result.height).toBe(2048);
    expect(result.provider).toBe('openai');
  });

  it('never keeps the base64 payload in the audit record', async () => {
    const { generator } = generatorWith(() => okResponse());
    const result = await generator.generate(imageRequest());

    expect(JSON.stringify(result.rawResponse)).not.toContain('iVBOR');
    expect(JSON.stringify(result.rawResponse)).toContain('[STRIPPED]');
  });

  it('treats rate limiting and 5xx as retryable', async () => {
    for (const status of [429, 500, 503]) {
      const { generator } = generatorWith(() => new Response('slow down', { status }));
      await expect(generator.generate(imageRequest())).rejects.toBeInstanceOf(RetryableError);
    }
  });

  it('treats a rejected request as non-retryable', async () => {
    for (const status of [400, 401, 403]) {
      const { generator } = generatorWith(() => new Response('nope', { status }));
      await expect(generator.generate(imageRequest())).rejects.toBeInstanceOf(NonRetryableError);
    }
  });

  it('rejects a response with no image', async () => {
    const { generator } = generatorWith(
      () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await expect(generator.generate(imageRequest())).rejects.toBeInstanceOf(RetryableError);
  });
});
