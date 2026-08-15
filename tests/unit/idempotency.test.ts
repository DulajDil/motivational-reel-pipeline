import { describe, expect, it } from 'vitest';

import {
  deriveJobId,
  jobIdempotencyKey,
  publishIdempotencyKey,
  quoteFingerprint,
  renderSeed,
} from '@mrp/shared';

describe('identity derivation', () => {
  const identity = { date: '2026-03-01', slot: 3, configVersion: '1' };

  it('derives the same jobId for the same slot every time', () => {
    expect(deriveJobId(identity)).toBe(deriveJobId({ ...identity }));
  });

  it('changes the jobId when any component changes', () => {
    const base = deriveJobId(identity);
    expect(deriveJobId({ ...identity, slot: 4 })).not.toBe(base);
    expect(deriveJobId({ ...identity, date: '2026-03-02' })).not.toBe(base);
    // Bumping the config version is the deliberate way to re-generate a slot.
    expect(deriveJobId({ ...identity, configVersion: '2' })).not.toBe(base);
  });

  it('embeds the date and slot so ids are legible in logs', () => {
    expect(deriveJobId(identity)).toMatch(/^job_20260301_03_[0-9a-f]{12}$/);
  });

  it('keys idempotency on the same components as the jobId', () => {
    expect(jobIdempotencyKey(identity)).toBe(jobIdempotencyKey({ ...identity }));
    expect(jobIdempotencyKey(identity)).not.toBe(
      jobIdempotencyKey({ ...identity, configVersion: '2' }),
    );
  });

  it('binds the publish key to job, platform and asset checksum', () => {
    const key = publishIdempotencyKey('job_a', 'instagram', 'checksum-1');
    expect(publishIdempotencyKey('job_a', 'instagram', 'checksum-1')).toBe(key);
    // A different platform is a different publication transaction.
    expect(publishIdempotencyKey('job_a', 'facebook', 'checksum-1')).not.toBe(key);
    // A re-render produces a new asset, so it is a new publication.
    expect(publishIdempotencyKey('job_a', 'instagram', 'checksum-2')).not.toBe(key);
  });

  it('derives a stable render seed from the jobId', () => {
    expect(renderSeed('job_a')).toBe(renderSeed('job_a'));
    expect(renderSeed('job_a')).not.toBe(renderSeed('job_b'));
  });
});

describe('quoteFingerprint', () => {
  it('collides on styling-only differences', () => {
    expect(quoteFingerprint('Begin again, gently.')).toBe(
      quoteFingerprint('  begin   again gently  '),
    );
    expect(quoteFingerprint('“Begin again”')).toBe(quoteFingerprint('begin again'));
  });

  it('separates genuinely different lines', () => {
    expect(quoteFingerprint('Begin again')).not.toBe(quoteFingerprint('Begin later'));
  });
});
