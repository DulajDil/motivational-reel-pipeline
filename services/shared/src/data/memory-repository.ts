import type { Platform } from '../config/schema.js';
import { NonRetryableError } from '../errors/index.js';
import type {
  Job,
  JobEvent,
  JobStatus,
  PlatformPublishState,
  PublishStatus,
  ReviewItem,
  ScheduleEntry,
} from '../types.js';
import type {
  AcquireIdempotencyResult,
  CostGuardResult,
  IdempotencyRecord,
  JobRepository,
  QuotaResult,
  RecentQuote,
} from './repository.js';

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory twin of `DynamoJobRepository`.
 *
 * It reproduces the conditional-write semantics (create-if-absent, transition
 * only from an expected state, atomic counters) so idempotency and state-machine
 * tests exercise real behaviour without AWS credentials.
 */
export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, Job>();

  private readonly idempotency = new Map<string, IdempotencyRecord>();

  private readonly content = new Map<string, RecentQuote>();

  private readonly publishStates = new Map<string, PlatformPublishState>();

  private readonly events = new Map<string, JobEvent[]>();

  private readonly schedule = new Map<string, ScheduleEntry>();

  private readonly reviews = new Map<string, ReviewItem>();

  private readonly quotas = new Map<string, number>();

  private readonly costs = new Map<string, number>();

  public constructor(private readonly clock: () => Date = () => new Date()) {}

  private now(): string {
    return this.clock().toISOString();
  }

  public async getJob(jobId: string): Promise<Job | undefined> {
    const job = this.jobs.get(jobId);
    return job === undefined ? undefined : clone(job);
  }

  public async createJob(job: Job): Promise<{ created: boolean; job: Job }> {
    const existing = this.jobs.get(job.jobId);
    if (existing) return { created: false, job: clone(existing) };
    this.jobs.set(job.jobId, clone(job));
    return { created: true, job: clone(job) };
  }

  public async updateJob(
    jobId: string,
    patch: Partial<Job>,
    expectedStatuses?: JobStatus[],
  ): Promise<Job> {
    const existing = this.jobs.get(jobId);
    if (!existing) throw new NonRetryableError(`Job ${jobId} not found`, { code: 'JOB_NOT_FOUND' });
    if (expectedStatuses && !expectedStatuses.includes(existing.status)) {
      throw new NonRetryableError(
        `Illegal transition for ${jobId}: status is ${existing.status}, expected one of ${expectedStatuses.join(', ')}`,
        { code: 'ILLEGAL_TRANSITION' },
      );
    }
    const updated: Job = { ...existing, ...clone(patch), jobId, updatedAt: this.now() };
    this.jobs.set(jobId, updated);
    return clone(updated);
  }

  public async listJobs(options: { status?: JobStatus; limit?: number } = {}): Promise<Job[]> {
    const limit = options.limit ?? 50;
    return [...this.jobs.values()]
      .filter((job) => options.status === undefined || job.status === options.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  public async acquireIdempotency(
    idempotencyKey: string,
    jobId: string,
    _ttlSeconds: number,
  ): Promise<AcquireIdempotencyResult> {
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) return { acquired: false, record: clone(existing) };
    const record: IdempotencyRecord = {
      idempotencyKey,
      jobId,
      state: 'IN_PROGRESS',
      createdAt: this.now(),
    };
    this.idempotency.set(idempotencyKey, record);
    return { acquired: true, record: clone(record) };
  }

  public async completeIdempotency(
    idempotencyKey: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    const existing = this.idempotency.get(idempotencyKey);
    if (!existing) return;
    this.idempotency.set(idempotencyKey, {
      ...existing,
      state: 'COMPLETED',
      result: clone(result),
      completedAt: this.now(),
    });
  }

  public async reserveContentFingerprint(
    fingerprint: string,
    text: string,
    jobId: string,
    _ttlSeconds: number,
  ): Promise<boolean> {
    if (this.content.has(fingerprint)) return false;
    this.content.set(fingerprint, { fingerprint, text, jobId, createdAt: this.now() });
    return true;
  }

  public async recentQuotes(limit: number): Promise<RecentQuote[]> {
    return [...this.content.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  public async getPublishState(
    jobId: string,
    platform: Platform,
  ): Promise<PlatformPublishState | undefined> {
    const state = this.publishStates.get(`${jobId}#${platform}`);
    return state === undefined ? undefined : clone(state);
  }

  public async initPublishState(state: PlatformPublishState & { jobId: string }): Promise<boolean> {
    const mapKey = `${state.jobId}#${state.platform}`;
    if (this.publishStates.has(mapKey)) return false;
    const { jobId: _jobId, ...rest } = state;
    this.publishStates.set(mapKey, clone(rest));
    return true;
  }

  public async transitionPublishState(
    jobId: string,
    platform: Platform,
    from: PublishStatus[],
    patch: Partial<PlatformPublishState> & { status: PublishStatus },
  ): Promise<boolean> {
    const mapKey = `${jobId}#${platform}`;
    const existing = this.publishStates.get(mapKey);
    if (!existing || !from.includes(existing.status)) return false;
    this.publishStates.set(mapKey, { ...existing, ...clone(patch) });
    return true;
  }

  public async appendEvent(
    jobId: string,
    event: Omit<JobEvent, 'jobId' | 'sequence'>,
  ): Promise<JobEvent> {
    const list = this.events.get(jobId) ?? [];
    const record: JobEvent = { ...clone(event), jobId, sequence: list.length + 1 };
    list.push(record);
    this.events.set(jobId, list);
    return clone(record);
  }

  public async listEvents(jobId: string): Promise<JobEvent[]> {
    return (this.events.get(jobId) ?? []).map(clone);
  }

  public async putScheduleEntry(entry: ScheduleEntry): Promise<void> {
    this.schedule.set(`${entry.jobId}#${entry.platform}`, clone(entry));
  }

  public async dueSchedule(
    platform: Platform,
    date: string,
    upToIso: string,
  ): Promise<ScheduleEntry[]> {
    return [...this.schedule.values()]
      .filter(
        (entry) =>
          entry.platform === platform &&
          entry.publishDate === date &&
          entry.status === 'PENDING' &&
          entry.publishAt <= upToIso,
      )
      .sort((a, b) => a.publishAt.localeCompare(b.publishAt))
      .map(clone);
  }

  public async openReview(jobId: string, reason: string): Promise<ReviewItem> {
    const existing = this.reviews.get(jobId);
    if (existing && existing.status === 'OPEN') return clone(existing);
    const item: ReviewItem = { jobId, reason, status: 'OPEN', createdAt: this.now() };
    this.reviews.set(jobId, item);
    return clone(item);
  }

  public async resolveReview(
    jobId: string,
    status: 'APPROVED' | 'REJECTED',
    resolvedBy: string,
    notes?: string,
  ): Promise<ReviewItem> {
    const existing = this.reviews.get(jobId);
    if (!existing) {
      throw new NonRetryableError(`No review item for ${jobId}`, { code: 'REVIEW_NOT_FOUND' });
    }
    if (existing.status !== 'OPEN') {
      throw new NonRetryableError(`Review for ${jobId} is already ${existing.status}`, {
        code: 'REVIEW_ALREADY_RESOLVED',
      });
    }
    const resolved: ReviewItem = {
      ...existing,
      status,
      resolvedBy,
      resolvedAt: this.now(),
      notes,
    };
    this.reviews.set(jobId, resolved);
    return clone(resolved);
  }

  public async listOpenReviews(limit = 50): Promise<ReviewItem[]> {
    return [...this.reviews.values()]
      .filter((item) => item.status === 'OPEN')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  public async consumeDailyQuota(
    platform: Platform,
    date: string,
    limit: number,
  ): Promise<QuotaResult> {
    const mapKey = `${platform}#${date}`;
    const count = this.quotas.get(mapKey) ?? 0;
    if (count >= limit) return { allowed: false, count, limit };
    this.quotas.set(mapKey, count + 1);
    return { allowed: true, count: count + 1, limit };
  }

  public async consumeCostBudget(
    period: string,
    amountUsd: number,
    budgetUsd: number,
  ): Promise<CostGuardResult> {
    const spent = this.costs.get(period) ?? 0;
    if (spent + amountUsd > budgetUsd) {
      return { allowed: false, spentUsd: spent, budgetUsd };
    }
    this.costs.set(period, spent + amountUsd);
    return { allowed: true, spentUsd: spent + amountUsd, budgetUsd };
  }
}
