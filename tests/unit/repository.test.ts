import { describe, expect, it } from 'vitest';

import { InMemoryJobRepository, type Job } from '@mrp/shared';

const makeJob = (overrides: Partial<Job> = {}): Job => ({
  jobId: 'job_1',
  idempotencyKey: 'key_1',
  status: 'CREATED',
  publishDate: '2026-03-01',
  slot: 0,
  configVersion: '1',
  publishMode: 'dry_run',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  platforms: {},
  generationAttempts: 0,
  ...overrides,
});

describe('InMemoryJobRepository conditional semantics', () => {
  it('creates a job only once', async () => {
    const repo = new InMemoryJobRepository();
    expect((await repo.createJob(makeJob())).created).toBe(true);
    const second = await repo.createJob(makeJob({ status: 'COMPLETED' }));
    expect(second.created).toBe(false);
    // The existing record wins; the second attempt must not overwrite it.
    expect(second.job.status).toBe('CREATED');
  });

  it('rejects an illegal status transition', async () => {
    const repo = new InMemoryJobRepository();
    await repo.createJob(makeJob());
    await expect(repo.updateJob('job_1', { status: 'RENDERED' }, ['QUOTE_READY'])).rejects.toThrow(
      /Illegal transition/,
    );
    await expect(repo.updateJob('job_1', { status: 'QUOTE_READY' }, ['CREATED'])).resolves.toBeTruthy();
  });

  it('acquires an idempotency record exactly once', async () => {
    const repo = new InMemoryJobRepository();
    expect((await repo.acquireIdempotency('k', 'job_1', 60)).acquired).toBe(true);

    const second = await repo.acquireIdempotency('k', 'job_1', 60);
    expect(second.acquired).toBe(false);
    expect(second.record.state).toBe('IN_PROGRESS');

    await repo.completeIdempotency('k', { status: 'COMPLETED' });
    const third = await repo.acquireIdempotency('k', 'job_1', 60);
    expect(third.record.state).toBe('COMPLETED');
    expect(third.record.result).toEqual({ status: 'COMPLETED' });
  });

  it('reserves a content fingerprint exactly once', async () => {
    const repo = new InMemoryJobRepository();
    expect(await repo.reserveContentFingerprint('fp', 'a line', 'job_1', 60)).toBe(true);
    expect(await repo.reserveContentFingerprint('fp', 'a line', 'job_2', 60)).toBe(false);
  });

  it('transitions publish state only from an expected status', async () => {
    const repo = new InMemoryJobRepository();
    await repo.initPublishState({
      jobId: 'job_1',
      platform: 'instagram',
      status: 'PENDING',
      idempotencyKey: 'pk',
      attempts: 0,
    });

    // A second init must not reset an in-flight publish.
    expect(
      await repo.initPublishState({
        jobId: 'job_1',
        platform: 'instagram',
        status: 'PENDING',
        idempotencyKey: 'pk',
        attempts: 0,
      }),
    ).toBe(false);

    expect(
      await repo.transitionPublishState('job_1', 'instagram', ['PENDING'], {
        status: 'IN_PROGRESS',
      }),
    ).toBe(true);
    // The same transition cannot be applied twice.
    expect(
      await repo.transitionPublishState('job_1', 'instagram', ['PENDING'], {
        status: 'IN_PROGRESS',
      }),
    ).toBe(false);

    await repo.transitionPublishState('job_1', 'instagram', ['IN_PROGRESS'], {
      status: 'PUBLISHED',
      mediaId: 'm1',
    });
    expect(
      await repo.transitionPublishState('job_1', 'instagram', ['IN_PROGRESS'], {
        status: 'PUBLISHED',
        mediaId: 'm2',
      }),
    ).toBe(false);
    expect((await repo.getPublishState('job_1', 'instagram'))?.mediaId).toBe('m1');
  });

  it('keeps events append-only and gap-free', async () => {
    const repo = new InMemoryJobRepository();
    await repo.appendEvent('job_1', { at: 'a', type: 'ONE', actor: 'workflow', detail: {} });
    await repo.appendEvent('job_1', { at: 'b', type: 'TWO', actor: 'workflow', detail: {} });
    const events = await repo.listEvents('job_1');
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.type)).toEqual(['ONE', 'TWO']);
  });

  it('enforces the daily publish cap atomically', async () => {
    const repo = new InMemoryJobRepository();
    const results = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(await repo.consumeDailyQuota('instagram', '2026-03-01', 3));
    }
    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false]);
    // A different day has its own budget.
    expect((await repo.consumeDailyQuota('instagram', '2026-03-02', 3)).allowed).toBe(true);
  });

  it('stops work when the cost budget is exhausted', async () => {
    const repo = new InMemoryJobRepository();
    expect((await repo.consumeCostBudget('daily#d', 0.6, 1)).allowed).toBe(true);
    expect((await repo.consumeCostBudget('daily#d', 0.6, 1)).allowed).toBe(false);
  });

  it('resolves a review item only once', async () => {
    const repo = new InMemoryJobRepository();
    await repo.openReview('job_1', 'needs_eyes');
    expect((await repo.listOpenReviews()).length).toBe(1);
    await repo.resolveReview('job_1', 'APPROVED', 'someone');
    await expect(repo.resolveReview('job_1', 'REJECTED', 'someone')).rejects.toThrow(
      /already/,
    );
    expect((await repo.listOpenReviews()).length).toBe(0);
  });
});
