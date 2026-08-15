import { sha256Hex } from './hash.js';

/**
 * Identity and idempotency.
 *
 * Three distinct keys, each guarding a different side effect:
 *
 *  1. `jobKey`        date + slot + config version. Derived at CreateJob, before any
 *                     content exists. Guarantees that a duplicate schedule event for
 *                     the same slot resolves to the *same* jobId instead of a new job.
 *  2. `contentKey`    quote fingerprint. Guards against publishing the same words twice.
 *  3. `publishKey`    jobId + platform + rendered asset checksum. Guards the external
 *                     side effect itself: the same asset cannot be posted to the same
 *                     platform twice unless an explicit repost is requested.
 */

export interface JobIdentityInput {
  /** Local calendar date of the intended publish, `YYYY-MM-DD`. */
  date: string;
  /** Content slot within the day, 0-based. */
  slot: number;
  /** Bumped whenever a config change should legitimately produce new content. */
  configVersion: string;
}

export const jobIdempotencyKey = ({ date, slot, configVersion }: JobIdentityInput): string =>
  sha256Hex(`v1|${date}|${slot}|${configVersion}`);

/**
 * jobId is a pure function of the idempotency key, so re-delivery of the same
 * trigger event produces a byte-identical jobId without a database round trip.
 */
export const deriveJobId = (input: JobIdentityInput): string => {
  const key = jobIdempotencyKey(input);
  const slot = String(input.slot).padStart(2, '0');
  return `job_${input.date.replace(/-/g, '')}_${slot}_${key.slice(0, 12)}`;
};

export const publishIdempotencyKey = (
  jobId: string,
  platform: string,
  assetChecksum: string,
): string => sha256Hex(`v1|${jobId}|${platform}|${assetChecksum}`);

/**
 * Deterministic render seed. Same job => same Ken Burns motion, so a re-render
 * after a transient failure produces the same video.
 */
export const renderSeed = (jobId: string): number => {
  const hex = sha256Hex(jobId).slice(0, 8);
  return Number.parseInt(hex, 16) >>> 0;
};

/** Small deterministic PRNG so renders are reproducible from the seed alone. */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
