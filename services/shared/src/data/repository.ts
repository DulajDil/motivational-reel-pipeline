import type { Platform } from '../config/schema.js';
import type {
  Job,
  JobEvent,
  JobStatus,
  PlatformPublishState,
  PublishStatus,
  ReviewItem,
  ScheduleEntry,
} from '../types.js';

export interface IdempotencyRecord {
  idempotencyKey: string;
  jobId: string;
  state: 'IN_PROGRESS' | 'COMPLETED';
  result?: Record<string, unknown> | undefined;
  createdAt: string;
  completedAt?: string | undefined;
}

export interface AcquireIdempotencyResult {
  /** False when a record already existed - the caller must reuse `record`. */
  acquired: boolean;
  record: IdempotencyRecord;
}

export interface RecentQuote {
  fingerprint: string;
  text: string;
  createdAt: string;
  jobId: string;
}

export interface QuotaResult {
  allowed: boolean;
  count: number;
  limit: number;
}

export interface CostGuardResult {
  allowed: boolean;
  spentUsd: number;
  budgetUsd: number;
}

/**
 * Persistence port.
 *
 * Two implementations exist: `DynamoJobRepository` (production) and
 * `InMemoryJobRepository` (unit/integration tests and local dry runs). Every
 * mutating method that guards a side effect is a conditional write, and the
 * in-memory twin reproduces the same conditional semantics so the idempotency
 * tests are meaningful without AWS.
 */
export interface JobRepository {
  getJob(jobId: string): Promise<Job | undefined>;
  /** Conditional put. `created:false` means the job already existed. */
  createJob(job: Job): Promise<{ created: boolean; job: Job }>;
  /**
   * Patch a job. When `expectedStatuses` is given the write is conditional on the
   * current status, which is how illegal state transitions are rejected.
   */
  updateJob(
    jobId: string,
    patch: Partial<Job>,
    expectedStatuses?: JobStatus[],
  ): Promise<Job>;
  listJobs(options?: { status?: JobStatus; limit?: number }): Promise<Job[]>;

  acquireIdempotency(
    idempotencyKey: string,
    jobId: string,
    ttlSeconds: number,
  ): Promise<AcquireIdempotencyResult>;
  completeIdempotency(idempotencyKey: string, result: Record<string, unknown>): Promise<void>;

  /** False when the fingerprint was already used inside the dedupe window. */
  reserveContentFingerprint(
    fingerprint: string,
    text: string,
    jobId: string,
    ttlSeconds: number,
  ): Promise<boolean>;
  recentQuotes(limit: number): Promise<RecentQuote[]>;

  getPublishState(jobId: string, platform: Platform): Promise<PlatformPublishState | undefined>;
  initPublishState(state: PlatformPublishState & { jobId: string }): Promise<boolean>;
  /** Conditional transition. Returns false when the current status is not in `from`. */
  transitionPublishState(
    jobId: string,
    platform: Platform,
    from: PublishStatus[],
    patch: Partial<PlatformPublishState> & { status: PublishStatus },
  ): Promise<boolean>;

  appendEvent(jobId: string, event: Omit<JobEvent, 'jobId' | 'sequence'>): Promise<JobEvent>;
  listEvents(jobId: string): Promise<JobEvent[]>;

  putScheduleEntry(entry: ScheduleEntry): Promise<void>;
  dueSchedule(platform: Platform, date: string, upToIso: string): Promise<ScheduleEntry[]>;

  openReview(jobId: string, reason: string): Promise<ReviewItem>;
  resolveReview(
    jobId: string,
    status: 'APPROVED' | 'REJECTED',
    resolvedBy: string,
    notes?: string,
  ): Promise<ReviewItem>;
  listOpenReviews(limit?: number): Promise<ReviewItem[]>;

  /** Atomic increment guarded by `limit`. `allowed:false` means the cap is reached. */
  consumeDailyQuota(platform: Platform, date: string, limit: number): Promise<QuotaResult>;
  /** Soft spend guard. `allowed:false` means the budget is exhausted. */
  consumeCostBudget(period: string, amountUsd: number, budgetUsd: number): Promise<CostGuardResult>;
}
