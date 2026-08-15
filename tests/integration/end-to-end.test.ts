import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DryRunPublisher } from '@mrp/providers';
import {
  createLocalRuntime,
  createJob,
  runJobLocally,
  type Runtime,
} from '@mrp/handlers';
import { inspectFfmpeg } from '@mrp/renderer';

/**
 * End-to-end integration, entirely offline.
 *
 * Runs the real handlers against the in-memory repository, the filesystem store
 * and the mock providers. No AWS credentials, no network, no Meta call.
 *
 * The FFmpeg-dependent cases are skipped automatically when the local FFmpeg
 * build cannot draw text, so the suite still passes on a machine without a
 * full build - see renderer/src/ffmpeg-bin.ts.
 */

let root: string;
let canRender = false;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mrp-e2e-'));
  try {
    canRender = (await inspectFfmpeg()).hasDrawtext;
  } catch {
    canRender = false;
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const makeRuntime = (overrides: Record<string, string> = {}): Runtime =>
  createLocalRuntime({
    root,
    // A window that is always open, so scheduling does not park the test.
    env: { PUBLISH_WINDOWS: '00:00-23:59', REEL_DURATION_SECONDS: '10', ...overrides },
  });

const paths = () => ({
  workDir: join(root, 'work'),
  fontDir: resolve(process.cwd(), 'renderer/fonts'),
});

describe('mocked end-to-end job', () => {
  it('reaches COMPLETED with a valid 9:16 MP4 and a manifest', async () => {
    if (!canRender) return;

    const runtime = makeRuntime();
    const result = await runJobLocally({ input: { slot: 0 }, runtime, ...paths() });

    expect(result.state.status).toBe('COMPLETED');

    const job = result.job;
    expect(job.content?.quote.text).toBeTruthy();
    expect(job.content?.quote.fingerprint).toHaveLength(64);
    expect(job.content?.quote.provider).toBe('mock');
    expect(job.content?.quote.promptVersion).toBeTruthy();

    // Video meets the 9:16 contract.
    expect(job.videoValidation?.passed).toBe(true);
    expect(job.videoValidation?.width).toBe(1080);
    expect(job.videoValidation?.height).toBe(1920);
    expect(job.videoValidation?.videoCodec).toBe('h264');
    expect(job.videoValidation?.audioCodec).toBe('aac');
    expect(job.videoValidation?.durationSeconds).toBeGreaterThanOrEqual(10);
    expect(job.videoValidation?.durationSeconds).toBeLessThanOrEqual(18);

    // Manifest records everything needed to reproduce the render.
    expect(job.render?.outputChecksumSha256).toHaveLength(64);
    expect(job.render?.ffmpegVersion).toContain('ffmpeg');
    expect(job.render?.ffmpegArgs.length).toBeGreaterThan(10);
    expect(job.render?.font.file).toBeTruthy();
    expect(job.render?.music.mode).toBe('silent');
    expect(job.render?.inputs[0]?.key).toBe(job.image?.key);

    // Both platforms reported independently.
    expect(result.summary?.platforms.map((entry) => entry.platform).sort()).toEqual([
      'facebook',
      'instagram',
    ]);
    for (const entry of result.summary?.platforms ?? []) {
      expect(entry.status).toBe('PUBLISHED');
    }

    // An append-only audit trail exists.
    const events = await runtime.repository.listEvents(job.jobId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['JOB_CREATED', 'QUOTE_ACCEPTED', 'IMAGE_GENERATED', 'PUBLISHED']),
    );
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
  }, 180_000);

  it('makes no Meta call and records the payloads it would have sent', async () => {
    if (!canRender) return;

    const runtime = makeRuntime();
    await runJobLocally({ input: { slot: 1 }, runtime, ...paths() });

    for (const platform of runtime.config.ENABLED_PLATFORMS) {
      const publisher = await runtime.publisherFor(platform);
      expect(publisher.live).toBe(false);
      expect(publisher).toBeInstanceOf(DryRunPublisher);

      const calls = (publisher as DryRunPublisher).calls;
      expect(calls.some((call) => call.phase === 'create')).toBe(true);
      expect(calls.some((call) => call.phase === 'publish')).toBe(true);
      // Recorded payloads must never carry a credential.
      expect(JSON.stringify(calls).toLowerCase()).not.toContain('access_token');
    }
  }, 180_000);
});

describe('duplicate delivery', () => {
  it('resolves a repeated trigger to the same job without duplicating work', async () => {
    const runtime = makeRuntime();

    const first = await createJob({ date: '2026-04-01', slot: 2 }, runtime);
    const second = await createJob({ date: '2026-04-01', slot: 2 }, runtime);

    expect(second.jobId).toBe(first.jobId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);

    // Exactly one JOB_CREATED event: the second call did not create a job.
    const events = await runtime.repository.listEvents(first.jobId);
    expect(events.filter((event) => event.type === 'JOB_CREATED')).toHaveLength(1);
  });

  it('returns the stored result instead of republishing a completed job', async () => {
    if (!canRender) return;

    const runtime = makeRuntime();
    const first = await runJobLocally({
      input: { date: '2026-04-02', slot: 0 },
      runtime,
      ...paths(),
    });
    expect(first.state.status).toBe('COMPLETED');

    const publishCallsBefore = await Promise.all(
      runtime.config.ENABLED_PLATFORMS.map(async (platform) => {
        const publisher = (await runtime.publisherFor(platform)) as DryRunPublisher;
        return publisher.calls.filter((call) => call.phase === 'publish').length;
      }),
    );

    // Same trigger delivered twice.
    const replay = await runJobLocally({
      input: { date: '2026-04-02', slot: 0 },
      runtime,
      ...paths(),
    });

    expect(replay.state.jobId).toBe(first.state.jobId);
    expect(replay.state.alreadyComplete).toBe(true);

    const publishCallsAfter = await Promise.all(
      runtime.config.ENABLED_PLATFORMS.map(async (platform) => {
        const publisher = (await runtime.publisherFor(platform)) as DryRunPublisher;
        return publisher.calls.filter((call) => call.phase === 'publish').length;
      }),
    );

    // The critical assertion: no additional publish attempt was made.
    expect(publishCallsAfter).toEqual(publishCallsBefore);
  }, 240_000);

  it('will not publish the same asset to the same platform twice', async () => {
    if (!canRender) return;

    const runtime = makeRuntime();
    await runJobLocally({ input: { date: '2026-04-03', slot: 0 }, runtime, ...paths() });

    const jobs = await runtime.repository.listJobs({ status: 'COMPLETED' });
    const jobId = jobs[0]!.jobId;

    const before = await runtime.repository.getPublishState(jobId, 'instagram');
    expect(before?.status).toBe('PUBLISHED');

    // A stray re-run of the publish branch must be refused by the conditional
    // transition, not by luck.
    const { createPublishContainer } = await import('@mrp/handlers');
    const outcome = await createPublishContainer(
      { jobId, idempotencyKey: '', publishDate: '', slot: 0, status: 'PUBLISHING', platform: 'instagram' },
      runtime,
    );
    expect(outcome.publishSkipped).toBe(true);
    expect(outcome.skipReason).toBe('already_published');

    const after = await runtime.repository.getPublishState(jobId, 'instagram');
    expect(after?.mediaId).toBe(before?.mediaId);
    expect(after?.attempts).toBe(before?.attempts);
  }, 240_000);
});

describe('guards', () => {
  it('refuses to start new work when the daily cost budget is spent', async () => {
    const runtime = makeRuntime({ DAILY_COST_BUDGET_USD: '0.3' });
    await createJob({ date: '2026-05-01', slot: 0 }, runtime);
    await expect(createJob({ date: '2026-05-01', slot: 1 }, runtime)).rejects.toThrow(
      /Daily cost budget/,
    );
  });

  it('caps publishes per platform per day', async () => {
    const runtime = makeRuntime({ MAX_DAILY_PUBLISHES_PER_PLATFORM: '1' });
    expect(
      (await runtime.repository.consumeDailyQuota('instagram', '2026-05-02', 1)).allowed,
    ).toBe(true);
    expect(
      (await runtime.repository.consumeDailyQuota('instagram', '2026-05-02', 1)).allowed,
    ).toBe(false);
  });
});
