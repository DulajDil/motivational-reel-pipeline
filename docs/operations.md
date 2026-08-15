# Operations runbook

## Emergency: stop everything now

```bash
aws ssm put-parameter --name /mrp/prod/kill-switch --value true --overwrite \
  --region ap-southeast-2
```

Effective within 30 seconds (the cached read TTL). It stops **new** jobs and
**all** scheduled publishing. It deletes nothing: every rendered asset, manifest
and receipt is retained.

It does **not** interrupt an execution that is already inside a publish call. If
a publish has already reached Meta, see *Content rollback* below.

Re-enable with `--value false`.

If the kill switch cannot be read at all, the code **fails safe and behaves as
though it is engaged**. An IAM or SSM outage therefore halts publishing rather
than proceeding blind.

---

## Monitoring

Dashboard: `mrp-<env>-pipeline` in CloudWatch. Namespace:
`MotivationalReelPipeline`, dimensioned by `Environment` and, where relevant,
`Platform`.

Funnel metrics — `JobsCreated` → `QuotesGenerated` → `ImagesGenerated` →
`ReelsRendered` → `VideosValidated` → `JobsScheduled` → `PublishSucceeded`. A
step that drops sharply relative to the one before it localises the problem
immediately.

### Alarms

| Alarm | Fires when | First action |
|---|---|---|
| `workflow-failures` | Any execution fails | Open the execution history; find the failed state |
| `dlq-messages` | DLQ non-empty | Inspect the message; usually a scheduler delivery failure |
| `publish-failures` | `PublishFailed ≥ 1` | Check publish state and last error code below |
| `render-errors` | Renderer Lambda errors | Check FFmpeg stderr in the renderer log group |
| `manual-review-backlog` | `ManualReviewQueued ≥ 3` | `npm run admin -- list-reviews --remote` |
| `cost-guard-tripped` | Spend guard stopped work | Review spend, then raise the budget deliberately |
| `kill-switch-blocking` | Kill switch blocked work | Confirm it is intentional |
| `low-publish-quota` | Instagram quota below 1 | Reduce `MAX_DAILY_PUBLISHES_PER_PLATFORM` |

All alarms notify the `mrp-<env>-alarms` SNS topic. Subscribe an address at
deploy time with `-c alarmEmail=you@example.com`.

### Where to look

| Question | Where |
|---|---|
| Why did this job fail? | Step Functions execution history for `jobId` |
| What happened, in order? | `EVT#` items under `JOB#<jobId>` — append-only |
| What exactly was rendered? | `manifests/<jobId>/render-manifest.json` |
| What did Meta return? | `receipts/<jobId>/<platform>.json` (redacted) |
| Is it published? | `PUB#<platform>` item under `JOB#<jobId>` |

---

## Triage by symptom

### Nothing is being generated

1. Kill switch engaged? `aws ssm get-parameter --name /mrp/<env>/kill-switch`
2. Cost guard tripped? Check the `CostGuardTripped` metric and the
   `COST#daily#<date>` item.
3. Did the scheduler fire? Check the `BatchTrigger` log group.
4. Executions rejected as duplicates? `execution_already_exists` in the
   BatchTrigger output is **normal** for a re-delivery — it is the guard working.

### Jobs fail at GenerateQuote

`ManualReviewRequiredError: quote_generation_exhausted` means every candidate was
rejected. The event detail lists the reasons.

- Mostly `too_similar` → history is saturated. Raise
  `QUOTE_DEDUPE_WINDOW_DAYS` scope or accept lower volume; the model is running
  out of distinct ideas.
- Mostly claim failures → the model is drifting into advice. Tighten
  `QUOTE_SYSTEM_PROMPT` and **bump `PROMPT_VERSIONS.quote`**.
- `ConfigurationError` naming the model → the model is not enabled in this
  account/region. Fix `BEDROCK_TEXT_MODEL_ID`.

### Jobs fail at ValidateImage

- `wrong_dimensions` → the image model is not honouring the requested size. Check
  the request shape for your model family (`BedrockImageBodyStyle`).
- `safe_area_not_clean` / `text_in_reserved_area` → the model keeps drawing in the
  reserved area. Strengthen the negative prompt, or move the reserved area.
- `moderation:*` → Rekognition flagged content. Do not override; regenerate.

### Renders fail

Check the renderer log group for FFmpeg stderr.

- `No such filter: 'drawtext'` → the image was built with an FFmpeg lacking
  libfreetype/libharfbuzz. Rebuild the container image.
- Timeouts → raise memory before timeout; FFmpeg is CPU-bound and Lambda scales
  CPU with memory.
- `ValidateVideo` failures are **terminal by design**. The job will not publish.
  Read the `failures` array; it names the platform and the constraint.

### Publish failures

Read `lastErrorCode` on the `PUB#<platform>` item.

| Code | Meaning | Action |
|---|---|---|
| `META_190` | Token invalid or expired | Rotate the token (below) |
| `META_200` / `META_10` | Missing permission | Re-check scopes and App Review |
| `META_4` / `META_32` / `META_613` | Rate limited | Automatic retry; reduce volume if persistent |
| `IG_QUOTA_EXHAUSTED` | Instagram rolling quota spent | Wait for the window |
| `CONTAINER_EXPIRED` | Container died pre-publish | Automatic; bounded |
| `CONTAINER_POLL_TIMEOUT` | Still processing after the poll budget | Check the media in-app before retrying |
| `publish_state_commit_failed` | **Published, but state not recorded** | See below — do not retry blindly |

#### `publish_state_commit_failed`

The Reel may be live. Automation stops and hands it to you.

1. Check the account in-app or via the Graph API for the media ID in the event
   detail.
2. **If it is live**, do not retry. Record the outcome and close the review.
3. **If it is not live**, `npm run admin -- retry-publish --job <id> --platform
   <p> --by <you> --remote`.

---

## Token rotation

Page access tokens expire. Rotate **before** expiry; an expired token surfaces as
`META_190` and stops publishing entirely.

1. Set a calendar reminder ~2 weeks before expiry, recorded at onboarding.
2. Generate a fresh long-lived Page token (see
   [`meta-onboarding.md`](meta-onboarding.md)).
3. Verify it with Meta's token-debug tooling: scopes, target Page, new expiry.
4. Update the secret:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id mrp-prod-meta \
     --secret-string file:///secure/path/meta-secret.json \
     --region ap-southeast-2
   ```
5. Delete the local file securely.
6. The publisher caches the secret for 5 minutes per container; new invocations
   pick it up automatically. To force it, publish a trivial config change to the
   publisher functions.
7. Confirm with one `manual_approval` publish before resuming `auto_publish`.

If a token is **leaked**: invalidate it in the Meta app dashboard first, then
rotate. Engage the kill switch while you work.

---

## Manual review queue

```bash
npm run admin -- list-reviews --remote
npm run admin -- get-job --job <jobId> --remote
npm run admin -- approve --job <jobId> --by you@example.com --remote
npm run admin -- reject  --job <jobId> --by you@example.com --remote
```

Approving does **not** publish. It marks the job eligible again; start a new
execution to resume. Rejecting cancels the job and retains its assets.

Requires `ADMIN_FUNCTION_NAME` and AWS credentials. The admin Lambda cannot
publish and cannot delete assets, by IAM.

---

## Retrying safely

`retry-job` rewinds a job to the last step with **no external side effect**:
`VIDEO_VALIDATED` if a render exists, otherwise `CREATED`. Only `FAILED`,
`MANUAL_REVIEW` and `PARTIALLY_COMPLETED` jobs may be retried.

`retry-publish` resets one platform from `FAILED`/`RETRYABLE` to `PENDING`. It
**refuses** if that platform is already `PUBLISHED` — reposting is a new job, a
deliberate decision, not a retry.

---

## Cost shutdown

Order of escalation:

1. **Reduce volume** — lower `DAILY_TARGET` and redeploy.
2. **Stop publishing, keep generating** — `PUBLISH_MODE=manual_approval`.
3. **Stop everything** — engage the kill switch. Storage costs continue.
4. **Stop storage growth** — shorten `retainFinalsDays`. Keep
   `retainAuditDays` long; manifests and receipts are small and are your audit
   trail.

The built-in guards are **soft** and estimate-based. Configure an AWS Budget with
its own alerting as the real backstop; the in-pipeline guard is a tripwire, not
accounting.

---

## Content rollback: what is and is not possible

**Before publishing:** everything is reversible. Cancel the job, reject the
review, engage the kill switch. Assets stay in S3.

**After a successful publish: this system cannot undo it.** There is no
compensating transaction, and adding one would be dishonest — the post has been
distributed, may have been seen, shared or archived by third parties.

To remove a published Reel:

1. Engage the kill switch, so nothing else goes out while you work.
2. Delete the post manually in the Meta tooling for that account.
3. Record the outcome on the job:
   `npm run admin -- get-job --job <id> --remote` to find it; note the action in
   your own incident record. The publish receipt in S3 stays as the audit trail
   of what was published and when.

This asymmetry is the reason for every guard upstream: validation before
publishing, dry-run by default, manual approval, daily caps, and the four-flag
production gate. The cheapest place to stop bad content is before it leaves.

---

## Incident response

1. **Contain** — engage the kill switch.
2. **Assess** — what published, to which platform, when? `receipts/` and the
   `EVT#` trail are authoritative.
3. **Remove** — manually, per above, if content must come down.
4. **Diagnose** — Step Functions history, then the relevant log group.
5. **Fix** — code, prompt or configuration. Bump `PROMPT_VERSIONS` if generation
   behaviour changed, so old and new output are distinguishable.
6. **Verify** — `npm run dry-run` locally, then one `manual_approval` publish.
7. **Resume** — disengage the kill switch.
8. **Record** — what happened, what changed, what would have caught it earlier.

### Credential exposure

Treat as urgent: invalidate the Meta token in the app dashboard, rotate the
secret, engage the kill switch, then review CloudTrail for `GetSecretValue` calls
from unexpected principals. Only the publisher role should appear.

---

## Routine maintenance

| Cadence | Task |
|---|---|
| Weekly | Clear the manual-review queue; skim published output for drift |
| Monthly | Check spend against budgets; check Instagram quota headroom |
| Quarterly | Re-verify Meta API version, Reel specs and permissions against current docs |
| Quarterly | Rebuild the renderer image to pick up FFmpeg and base-image patches |
| Before expiry | Rotate the Page access token |
| On any prompt change | Bump `PROMPT_VERSIONS`; on config changes that should regenerate content, bump `CONFIG_VERSION` |
