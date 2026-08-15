import type { Platform } from '../config/schema.js';

/**
 * Single-table key construction. Every access pattern in docs/data-model.md maps
 * to exactly one function here so key formats cannot drift between call sites.
 */

export const keys = {
  job: (jobId: string) => ({ pk: `JOB#${jobId}`, sk: 'META' }),

  idempotency: (idempotencyKey: string) => ({ pk: `IDEM#${idempotencyKey}`, sk: 'IDEM' }),

  content: (fingerprint: string) => ({ pk: `CONTENT#${fingerprint}`, sk: 'CONTENT' }),

  publish: (jobId: string, platform: Platform) => ({ pk: `JOB#${jobId}`, sk: `PUB#${platform}` }),

  /** Zero-padded so the lexical sort of the sort key matches numeric order. */
  event: (jobId: string, sequence: number) => ({
    pk: `JOB#${jobId}`,
    sk: `EVT#${String(sequence).padStart(6, '0')}`,
  }),

  review: (jobId: string) => ({ pk: `JOB#${jobId}`, sk: 'REVIEW' }),

  schedule: (jobId: string, platform: Platform) => ({
    pk: `JOB#${jobId}`,
    sk: `SCHED#${platform}`,
  }),

  dailyQuota: (platform: Platform, date: string) => ({
    pk: `QUOTA#${platform}#${date}`,
    sk: 'COUNTER',
  }),

  costGuard: (period: string) => ({ pk: `COST#${period}`, sk: 'GUARD' }),
} as const;

/** GSI1 - schedule lookups by intended publish time. */
export const gsi1 = {
  name: 'gsi1-schedule',
  partition: (platform: Platform, date: string) => `SCHED#${platform}#${date}`,
  sort: (publishAtIso: string, jobId: string) => `${publishAtIso}#${jobId}`,
};

/** GSI2 - recent content history for dedupe. */
export const gsi2 = {
  name: 'gsi2-content-history',
  partition: () => 'CONTENT#ALL',
  sort: (createdAtIso: string) => createdAtIso,
};

/** GSI3 - work queues: open reviews and retryable publishes. */
export const gsi3 = {
  name: 'gsi3-status',
  partition: (queue: 'REVIEW' | 'PUBLISH' | 'JOB', status: string) => `${queue}#${status}`,
  sort: (createdAtIso: string, jobId: string) => `${createdAtIso}#${jobId}`,
};

export const ATTRS = {
  pk: 'pk',
  sk: 'sk',
  gsi1pk: 'gsi1pk',
  gsi1sk: 'gsi1sk',
  gsi2pk: 'gsi2pk',
  gsi2sk: 'gsi2sk',
  gsi3pk: 'gsi3pk',
  gsi3sk: 'gsi3sk',
  ttl: 'expiresAt',
} as const;
