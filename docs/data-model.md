# Data model

Single DynamoDB table, `mrp-<env>-core`, with three global secondary indexes.

## Why one table

Every access pattern is either "everything about one job" or "the next items in
one of three queues". Nothing joins across unrelated entities.

One table buys two things that matter here:

1. **Atomic conditional writes on the same partition.** The job item, its publish
   rows and its audit events share `JOB#<jobId>`, so state transitions do not
   need cross-table coordination.
2. **One round trip for a whole job.** A single `Query` on `JOB#<jobId>` returns
   the job, both publish states, the schedule rows, the review item and the full
   event history.

Idempotency, content fingerprints, quota counters and cost guards live in their
own partitions because they are keyed by something other than a job — but they
are still conditional-write targets in the same table, which keeps the guard
logic uniform.

## Keys

Every key string is built by exactly one function in
[`services/shared/src/data/keys.ts`](../services/shared/src/data/keys.ts). No key
format is ever written inline.

| Entity | `pk` | `sk` | Notes |
|---|---|---|---|
| Job | `JOB#<jobId>` | `META` | The job record |
| Publish state | `JOB#<jobId>` | `PUB#<platform>` | One per platform, independent |
| Audit event | `JOB#<jobId>` | `EVT#<000001>` | Append-only, zero-padded |
| Schedule | `JOB#<jobId>` | `SCHED#<platform>` | Intended publish time |
| Review | `JOB#<jobId>` | `REVIEW` | At most one open per job |
| Idempotency | `IDEM#<key>` | `IDEM` | TTL 30 days |
| Content fingerprint | `CONTENT#<sha256>` | `CONTENT` | TTL = dedupe window |
| Daily quota | `QUOTA#<platform>#<date>` | `COUNTER` | TTL 40 days |
| Cost guard | `COST#<period>` | `GUARD` | TTL 400 days |

`jobId` is itself derived: `job_<yyyymmdd>_<slot>_<hash12>` where the hash covers
date + slot + config version. It is legible in a log line and deterministic, so
a duplicate trigger produces the same ID without a lookup.

## Indexes

### GSI1 — schedule by intended publish time

- `gsi1pk` = `SCHED#<platform>#<yyyy-mm-dd>`
- `gsi1sk` = `<publishAtIso>#<jobId>`
- Projection: INCLUDE (`jobId`, `platform`, `publishAt`, `publishDate`, `status`)

Answers *"what is due to publish to Instagram today, up to now?"* with a range
query. Partitioned by day so no partition grows unboundedly.

### GSI2 — recent content history

- `gsi2pk` = `CONTENT#ALL`
- `gsi2sk` = `<createdAtIso>`
- Projection: INCLUDE (`fingerprint`, `text`, `jobId`, `createdAt`)

Answers *"what were the last N quotes?"*, which feeds both the avoid-list in the
generation prompt and the similarity check.

A single hot partition is acceptable here **only because** the write rate is
bounded by `DAILY_TARGET` (tens per day) and reads happen once per job. At
thousands per day, shard the partition key by month
(`CONTENT#<yyyy-mm>`) and query the current and previous shard.

### GSI3 — work queues

- `gsi3pk` = `<QUEUE>#<STATUS>` — `REVIEW#OPEN`, `PUBLISH#RETRYABLE`, `JOB#FAILED`
- `gsi3sk` = `<createdAtIso>#<jobId>`
- Projection: ALL

Answers the operational questions: open reviews, retryable publishes, jobs by
status. It is also why `listJobs` **refuses** to run without a status — an
unbounded `Scan` is not permitted by the repository.

## Access patterns

| # | Pattern | How |
|---|---|---|
| 1 | Get a job by ID | `GetItem` on `JOB#<id>` / `META` |
| 2 | Full job history | `Query` `JOB#<id>`, `begins_with(sk, 'EVT#')` |
| 3 | Everything about a job | `Query` `JOB#<id>` |
| 4 | Has this trigger run? | `GetItem` on `IDEM#<key>` |
| 5 | Has this quote been used? | Conditional `PutItem` on `CONTENT#<fp>` |
| 6 | Recent quotes | `Query` GSI2, descending, limit N |
| 7 | Due to publish | `Query` GSI1, `gsi1sk <= now` |
| 8 | Publish state per platform | `GetItem` on `JOB#<id>` / `PUB#<platform>` |
| 9 | Open reviews | `Query` GSI3 on `REVIEW#OPEN` |
| 10 | Jobs by status | `Query` GSI3 on `JOB#<status>` |
| 11 | Daily cap check + consume | Conditional `UpdateItem` with `ADD` |
| 12 | Spend guard check + consume | Conditional `UpdateItem` with `ADD` |

## Conditional writes

Every write that guards a side effect is conditional. This is the core of the
idempotency story, not a nicety.

| Operation | Condition | Prevents |
|---|---|---|
| `createJob` | `attribute_not_exists(pk)` | Two jobs for one slot |
| `acquireIdempotency` | `attribute_not_exists(pk)` | Re-running a completed trigger |
| `reserveContentFingerprint` | `attribute_not_exists(pk)` | Publishing the same words twice |
| `initPublishState` | `attribute_not_exists(pk)` | Resetting an in-flight publish |
| `transitionPublishState` | `#status IN (:from...)` | Double publish; racing executions |
| `updateJob` | `#status IN (:expected...)` | Illegal state transitions |
| `appendEvent` | `attribute_not_exists(pk)` | Rewriting audit history |
| `consumeDailyQuota` | `attribute_not_exists(#c) OR #c < :limit` | Exceeding the daily cap |
| `consumeCostBudget` | `spentUsd <= :headroom` | Exceeding the spend guard |
| `resolveReview` | `#status = :open` | Resolving a review twice |

Example — the transition that actually stops a double publish:

```
UpdateExpression:    SET #status = :status, mediaId = :mediaId, ...
ConditionExpression: attribute_exists(pk) AND #status IN (:f0)
                     -- :f0 = 'IN_PROGRESS'
```

A second execution arriving after the first has committed finds `PUBLISHED`,
fails the condition, and the handler raises `ManualReviewRequiredError` rather
than publishing again.

## Immutability and audit

`EVT#` items are **append-only**. Sequence numbers come from an atomic counter on
the job item, and the write is conditional on the key not existing, so history
can be added to but never rewritten or gapped.

Event details pass through `redact()` before they are written. No token, no
signed URL and no raw provider response ever lands in the table.

Publish receipts are additionally written to S3 under `receipts/`, retained far
longer than the media, and are the durable record of what was published.

## TTL

Attribute: `expiresAt` (epoch seconds).

| Entity | TTL | Rationale |
|---|---|---|
| Idempotency | 30 days | Long past any plausible re-delivery |
| Content fingerprint | `QUOTE_DEDUPE_WINDOW_DAYS` (90) | Defines the dedupe window |
| Daily quota | 40 days | Enough to investigate last month |
| Cost guard | 400 days | Year-over-year comparison |
| Job, publish, events, reviews | **none** | Permanent audit trail |

Jobs and their events deliberately have no TTL. They are small, and they are the
record of what was published on the operator's behalf.

## Example items

```jsonc
// Job
{
  "pk": "JOB#job_20260301_00_a1b2c3d4e5f6", "sk": "META", "entity": "JOB",
  "jobId": "job_20260301_00_a1b2c3d4e5f6",
  "idempotencyKey": "9f2c…", "status": "COMPLETED",
  "publishDate": "2026-03-01", "slot": 0, "configVersion": "1",
  "publishMode": "auto_publish",
  "content": { "quote": { "text": "…", "fingerprint": "…", "modelId": "…",
                          "promptVersion": "quote-2025-01-a" } },
  "render": { "outputChecksumSha256": "…", "font": { "license": "SIL OFL 1.1" },
              "music": { "mode": "silent" } },
  "gsi3pk": "JOB#COMPLETED", "gsi3sk": "2026-03-01T18:00:00.000Z#job_…"
}

// Publish state — one per platform, entirely independent
{
  "pk": "JOB#job_20260301_00_a1b2c3d4e5f6", "sk": "PUB#instagram",
  "entity": "PUBLISH", "status": "PUBLISHED", "attempts": 1,
  "idempotencyKey": "c4d5…", "containerId": "179…", "mediaId": "180…",
  "publishedAt": "2026-03-01T18:04:11.000Z",
  "gsi3pk": "PUBLISH#PUBLISHED", "gsi3sk": "2026-03-01T18:03:02.000Z#job_…"
}

// Audit event — append-only, redacted
{
  "pk": "JOB#job_20260301_00_a1b2c3d4e5f6", "sk": "EVT#000007",
  "entity": "EVENT", "sequence": 7, "type": "PUBLISHED", "actor": "workflow",
  "at": "2026-03-01T18:04:11.000Z",
  "detail": { "platform": "instagram", "mediaId": "180…", "live": true }
}

// Daily cap counter
{ "pk": "QUOTA#instagram#2026-03-01", "sk": "COUNTER",
  "entity": "QUOTA", "count": 3, "expiresAt": 1780000000 }
```

## Capacity

On-demand billing. At 30 reels/day the table sees roughly a few hundred writes
and a few hundred reads per day — far below any provisioned tier worth managing.
Point-in-time recovery is on; deletion protection is on in production.
