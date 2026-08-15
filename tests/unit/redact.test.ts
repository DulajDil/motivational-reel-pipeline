import { describe, expect, it } from 'vitest';

import { REDACTED, redact, redactPayload, redactUrl } from '@mrp/shared';

describe('redact', () => {
  it('masks credential-shaped keys at any depth', () => {
    const input = {
      ok: 'visible',
      access_token: 'EAAabcdefghijklmnopqrstuvwxyz0123456789',
      nested: { appSecret: 'super-secret', authorization: 'Bearer abc' },
      list: [{ apiKey: 'k' }],
    };
    const output = redact(input);
    expect(output.ok).toBe('visible');
    expect(output.access_token).toBe(REDACTED);
    expect(output.nested.appSecret).toBe(REDACTED);
    expect(output.nested.authorization).toBe(REDACTED);
    expect(output.list[0]!.apiKey).toBe(REDACTED);
  });

  it('masks credential-shaped values even under an innocent key', () => {
    expect(redact({ note: 'EAAabcdefghijklmnopqrstuvwxyz0123456789' }).note).toBe(REDACTED);
    expect(redact({ note: 'AKIAIOSFODNN7EXAMPLE' }).note).toBe(REDACTED);
    expect(redact({ note: 'a normal sentence' }).note).toBe('a normal sentence');
  });

  it('strips signing parameters from URLs but keeps them recognisable', () => {
    const url =
      'https://bucket.s3.amazonaws.com/renders/job/reel.mp4?X-Amz-Signature=deadbeef&X-Amz-Expires=3600';
    const output = redactUrl(url);
    expect(output).toContain('renders/job/reel.mp4');
    expect(output).toContain('X-Amz-Expires=3600');
    expect(output).not.toContain('deadbeef');
  });

  it('redacts URLs found anywhere in a structure', () => {
    const output = redact({ videoUrl: 'https://x.test/a?access_token=EAAsecretvalue' });
    expect(output.videoUrl).not.toContain('EAAsecretvalue');
  });

  it('survives cycles', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect((redact(cyclic) as { self: unknown }).self).toBe('[CIRCULAR]');
  });

  it('caps oversized payloads', () => {
    const output = redactPayload({ blob: 'x'.repeat(50_000) }, 1_000) as {
      truncated?: boolean;
      bytes?: number;
    };
    expect(output.truncated).toBe(true);
    expect(output.bytes).toBeGreaterThan(1_000);
  });
});
