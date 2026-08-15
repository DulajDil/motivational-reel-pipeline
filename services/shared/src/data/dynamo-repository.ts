import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import type { Platform } from '../config/schema.js';
import { NonRetryableError, RetryableError } from '../errors/index.js';
import { redact } from '../util/redact.js';
import type {
  Job,
  JobEvent,
  JobStatus,
  PlatformPublishState,
  PublishStatus,
  ReviewItem,
  ScheduleEntry,
} from '../types.js';
import { ATTRS, gsi1, gsi2, gsi3, keys } from './keys.js';
import type {
  AcquireIdempotencyResult,
  CostGuardResult,
  IdempotencyRecord,
  JobRepository,
  QuotaResult,
  RecentQuote,
} from './repository.js';

const isConditionFailure = (error: unknown): boolean =>
  error instanceof ConditionalCheckFailedException ||
  (error as { name?: string })?.name === 'ConditionalCheckFailedException';

const nowIso = (): string => new Date().toISOString();

const ttlAt = (seconds: number): number => Math.floor(Date.now() / 1000) + seconds;

/** Attribute names that must never be overwritten by a generic patch. */
const IMMUTABLE_JOB_ATTRS = new Set(['pk', 'sk', 'jobId', 'createdAt', 'idempotencyKey', 'entity']);

export interface DynamoJobRepositoryOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  region?: string;
}

/**
 * Single-table DynamoDB implementation. See docs/data-model.md for the key
 * patterns; `keys.ts` is the only place key strings are built.
 *
 * Every write that guards a side effect is conditional:
 *   - createJob                attribute_not_exists(pk)
 *   - acquireIdempotency       attribute_not_exists(pk)
 *   - reserveContentFingerprint attribute_not_exists(pk)
 *   - initPublishState         attribute_not_exists(pk)
 *   - transitionPublishState   #status IN (:from...)
 *   - consumeDailyQuota        attribute_not_exists(#c) OR #c < :limit
 *   - appendEvent              attribute_not_exists(pk)  (append-only audit trail)
 */
export class DynamoJobRepository implements JobRepository {
  private readonly doc: DynamoDBDocumentClient;

  private readonly table: string;

  public constructor(options: DynamoJobRepositoryOptions) {
    this.table = options.tableName;
    this.doc =
      options.client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: options.region }), {
        marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
      });
  }

  // ------------------------------------------------------------------ jobs

  public async getJob(jobId: string): Promise<Job | undefined> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: keys.job(jobId) }),
    );
    return result.Item === undefined ? undefined : (result.Item as unknown as Job);
  }

  public async createJob(job: Job): Promise<{ created: boolean; job: Job }> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...keys.job(job.jobId),
            entity: 'JOB',
            ...job,
            [ATTRS.gsi3pk]: gsi3.partition('JOB', job.status),
            [ATTRS.gsi3sk]: gsi3.sort(job.createdAt, job.jobId),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { created: true, job };
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const existing = await this.getJob(job.jobId);
      if (!existing) throw new RetryableError('Job create raced and then vanished', { cause: error });
      return { created: false, job: existing };
    }
  }

  public async updateJob(
    jobId: string,
    patch: Partial<Job>,
    expectedStatuses?: JobStatus[],
  ): Promise<Job> {
    const entries = Object.entries(patch).filter(
      ([key, value]) => value !== undefined && !IMMUTABLE_JOB_ATTRS.has(key),
    );
    entries.push(['updatedAt', nowIso()]);

    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];

    entries.forEach(([key, value], index) => {
      names[`#a${index}`] = key;
      values[`:v${index}`] = value;
      sets.push(`#a${index} = :v${index}`);
    });

    // Keep the GSI3 work-queue projection in sync with status.
    if (patch.status) {
      names['#g3pk'] = ATTRS.gsi3pk;
      values[':g3pk'] = gsi3.partition('JOB', patch.status);
      sets.push('#g3pk = :g3pk');
    }

    let condition = 'attribute_exists(pk)';
    if (expectedStatuses && expectedStatuses.length > 0) {
      names['#status'] = 'status';
      const placeholders = expectedStatuses.map((status, index) => {
        values[`:s${index}`] = status;
        return `:s${index}`;
      });
      condition += ` AND #status IN (${placeholders.join(', ')})`;
    }

    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.job(jobId),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return result.Attributes as unknown as Job;
    } catch (error) {
      if (isConditionFailure(error)) {
        const expectation = expectedStatuses
          ? ` (expected status in ${expectedStatuses.join(', ')})`
          : '';
        throw new NonRetryableError(
          `Illegal or lost update for job ${jobId}${expectation}`,
          { code: 'ILLEGAL_TRANSITION', cause: error, context: { jobId } },
        );
      }
      throw error;
    }
  }

  public async listJobs(options: { status?: JobStatus; limit?: number } = {}): Promise<Job[]> {
    if (!options.status) {
      throw new NonRetryableError(
        'listJobs requires a status: an unbounded table scan is not permitted.',
        { code: 'SCAN_FORBIDDEN' },
      );
    }
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: gsi3.name,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': ATTRS.gsi3pk },
        ExpressionAttributeValues: { ':pk': gsi3.partition('JOB', options.status) },
        ScanIndexForward: false,
        Limit: options.limit ?? 50,
      }),
    );
    return (result.Items ?? []) as unknown as Job[];
  }

  // --------------------------------------------------------- idempotency

  public async acquireIdempotency(
    idempotencyKey: string,
    jobId: string,
    ttlSeconds: number,
  ): Promise<AcquireIdempotencyResult> {
    const record: IdempotencyRecord = {
      idempotencyKey,
      jobId,
      state: 'IN_PROGRESS',
      createdAt: nowIso(),
    };
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...keys.idempotency(idempotencyKey),
            entity: 'IDEMPOTENCY',
            ...record,
            [ATTRS.ttl]: ttlAt(ttlSeconds),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { acquired: true, record };
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const existing = await this.doc.send(
        new GetCommand({ TableName: this.table, Key: keys.idempotency(idempotencyKey) }),
      );
      if (!existing.Item) {
        throw new RetryableError('Idempotency record raced and then expired', { cause: error });
      }
      return { acquired: false, record: existing.Item as unknown as IdempotencyRecord };
    }
  }

  public async completeIdempotency(
    idempotencyKey: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.idempotency(idempotencyKey),
        UpdateExpression: 'SET #state = :state, #result = :result, completedAt = :at',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#state': 'state', '#result': 'result' },
        ExpressionAttributeValues: {
          ':state': 'COMPLETED',
          ':result': redact(result),
          ':at': nowIso(),
        },
      }),
    );
  }

  // ------------------------------------------------------------- content

  public async reserveContentFingerprint(
    fingerprint: string,
    text: string,
    jobId: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const createdAt = nowIso();
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...keys.content(fingerprint),
            entity: 'CONTENT',
            fingerprint,
            text,
            jobId,
            createdAt,
            [ATTRS.gsi2pk]: gsi2.partition(),
            [ATTRS.gsi2sk]: gsi2.sort(createdAt),
            [ATTRS.ttl]: ttlAt(ttlSeconds),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  public async recentQuotes(limit: number): Promise<RecentQuote[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: gsi2.name,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': ATTRS.gsi2pk },
        ExpressionAttributeValues: { ':pk': gsi2.partition() },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []) as unknown as RecentQuote[];
  }

  // ------------------------------------------------------------- publish

  public async getPublishState(
    jobId: string,
    platform: Platform,
  ): Promise<PlatformPublishState | undefined> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: keys.publish(jobId, platform) }),
    );
    return result.Item === undefined ? undefined : (result.Item as unknown as PlatformPublishState);
  }

  public async initPublishState(state: PlatformPublishState & { jobId: string }): Promise<boolean> {
    const { jobId, ...rest } = state;
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            ...keys.publish(jobId, state.platform),
            entity: 'PUBLISH',
            jobId,
            ...rest,
            [ATTRS.gsi3pk]: gsi3.partition('PUBLISH', state.status),
            [ATTRS.gsi3sk]: gsi3.sort(state.firstAttemptAt ?? nowIso(), jobId),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  public async transitionPublishState(
    jobId: string,
    platform: Platform,
    from: PublishStatus[],
    patch: Partial<PlatformPublishState> & { status: PublishStatus },
  ): Promise<boolean> {
    const names: Record<string, string> = { '#status': 'status', '#g3pk': ATTRS.gsi3pk };
    const values: Record<string, unknown> = {
      ':status': patch.status,
      ':g3pk': gsi3.partition('PUBLISH', patch.status),
    };
    const sets = ['#status = :status', '#g3pk = :g3pk'];

    Object.entries(patch)
      .filter(([key, value]) => key !== 'status' && value !== undefined)
      .forEach(([key, value], index) => {
        names[`#p${index}`] = key;
        values[`:p${index}`] = value;
        sets.push(`#p${index} = :p${index}`);
      });

    const fromPlaceholders = from.map((status, index) => {
      values[`:f${index}`] = status;
      return `:f${index}`;
    });

    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.publish(jobId, platform),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: `attribute_exists(pk) AND #status IN (${fromPlaceholders.join(', ')})`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  // -------------------------------------------------------------- events

  public async appendEvent(
    jobId: string,
    event: Omit<JobEvent, 'jobId' | 'sequence'>,
  ): Promise<JobEvent> {
    // Atomic counter on the job item hands out gap-free sequence numbers.
    const counter = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: keys.job(jobId),
        UpdateExpression: 'ADD eventSequence :one',
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const sequence = Number(counter.Attributes?.eventSequence ?? 1);
    const record: JobEvent = { ...event, jobId, sequence, detail: redact(event.detail) };

    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...keys.event(jobId, sequence), entity: 'EVENT', ...record },
        // Append-only: an existing sequence is never overwritten.
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return record;
  }

  public async listEvents(jobId: string): Promise<JobEvent[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': ATTRS.pk, '#sk': ATTRS.sk },
        ExpressionAttributeValues: { ':pk': `JOB#${jobId}`, ':prefix': 'EVT#' },
      }),
    );
    return (result.Items ?? []) as unknown as JobEvent[];
  }

  // ------------------------------------------------------------ schedule

  public async putScheduleEntry(entry: ScheduleEntry): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...keys.schedule(entry.jobId, entry.platform),
          entity: 'SCHEDULE',
          ...entry,
          [ATTRS.gsi1pk]: gsi1.partition(entry.platform, entry.publishDate),
          [ATTRS.gsi1sk]: gsi1.sort(entry.publishAt, entry.jobId),
        },
      }),
    );
  }

  public async dueSchedule(
    platform: Platform,
    date: string,
    upToIso: string,
  ): Promise<ScheduleEntry[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: gsi1.name,
        KeyConditionExpression: '#pk = :pk AND #sk <= :upTo',
        FilterExpression: '#status = :pending',
        ExpressionAttributeNames: {
          '#pk': ATTRS.gsi1pk,
          '#sk': ATTRS.gsi1sk,
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':pk': gsi1.partition(platform, date),
          ':upTo': `${upToIso}#￿`,
          ':pending': 'PENDING',
        },
      }),
    );
    return (result.Items ?? []) as unknown as ScheduleEntry[];
  }

  // -------------------------------------------------------------- review

  public async openReview(jobId: string, reason: string): Promise<ReviewItem> {
    const item: ReviewItem = { jobId, reason, status: 'OPEN', createdAt: nowIso() };
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...keys.review(jobId),
          entity: 'REVIEW',
          ...item,
          [ATTRS.gsi3pk]: gsi3.partition('REVIEW', 'OPEN'),
          [ATTRS.gsi3sk]: gsi3.sort(item.createdAt, jobId),
        },
      }),
    );
    return item;
  }

  public async resolveReview(
    jobId: string,
    status: 'APPROVED' | 'REJECTED',
    resolvedBy: string,
    notes?: string,
  ): Promise<ReviewItem> {
    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.review(jobId),
          UpdateExpression:
            'SET #status = :status, resolvedBy = :by, resolvedAt = :at, notes = :notes, #g3pk = :g3pk',
          ConditionExpression: 'attribute_exists(pk) AND #status = :open',
          ExpressionAttributeNames: { '#status': 'status', '#g3pk': ATTRS.gsi3pk },
          ExpressionAttributeValues: {
            ':status': status,
            ':open': 'OPEN',
            ':by': resolvedBy,
            ':at': nowIso(),
            ':notes': notes ?? null,
            ':g3pk': gsi3.partition('REVIEW', status),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return result.Attributes as unknown as ReviewItem;
    } catch (error) {
      if (isConditionFailure(error)) {
        throw new NonRetryableError(`Review for ${jobId} is missing or already resolved`, {
          code: 'REVIEW_ALREADY_RESOLVED',
          cause: error,
        });
      }
      throw error;
    }
  }

  public async listOpenReviews(limit = 50): Promise<ReviewItem[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: gsi3.name,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': ATTRS.gsi3pk },
        ExpressionAttributeValues: { ':pk': gsi3.partition('REVIEW', 'OPEN') },
        Limit: limit,
      }),
    );
    return (result.Items ?? []) as unknown as ReviewItem[];
  }

  // --------------------------------------------------------------- caps

  public async consumeDailyQuota(
    platform: Platform,
    date: string,
    limit: number,
  ): Promise<QuotaResult> {
    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.dailyQuota(platform, date),
          UpdateExpression: 'ADD #count :one SET entity = :entity, #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': ATTRS.ttl },
          ExpressionAttributeValues: {
            ':one': 1,
            ':limit': limit,
            ':entity': 'QUOTA',
            ':ttl': ttlAt(60 * 60 * 24 * 40),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { allowed: true, count: Number(result.Attributes?.count ?? 1), limit };
    } catch (error) {
      if (isConditionFailure(error)) return { allowed: false, count: limit, limit };
      throw error;
    }
  }

  public async consumeCostBudget(
    period: string,
    amountUsd: number,
    budgetUsd: number,
  ): Promise<CostGuardResult> {
    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: keys.costGuard(period),
          UpdateExpression: 'ADD spentUsd :amount SET entity = :entity, #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(spentUsd) OR spentUsd <= :headroom',
          ExpressionAttributeNames: { '#ttl': ATTRS.ttl },
          ExpressionAttributeValues: {
            ':amount': amountUsd,
            ':headroom': budgetUsd - amountUsd,
            ':entity': 'COST_GUARD',
            ':ttl': ttlAt(60 * 60 * 24 * 400),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return { allowed: true, spentUsd: Number(result.Attributes?.spentUsd ?? 0), budgetUsd };
    } catch (error) {
      if (isConditionFailure(error)) return { allowed: false, spentUsd: budgetUsd, budgetUsd };
      throw error;
    }
  }
}
