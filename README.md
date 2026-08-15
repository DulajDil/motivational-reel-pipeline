# motivational-reel-pipeline

An AWS pipeline that generates, validates, renders, schedules and publishes
motivational Reels to one Facebook Page and one Instagram Professional account —
using the official Meta Graph APIs only.

Target output: **at least 5 polished Reels per day**, with headroom to grow to
20–30 without changing the architecture.

Each Reel is a vertical 9:16 1080×1920 MP4 (H.264 + AAC @ 48 kHz), 10–18
seconds, built from a warm hand-drawn pencil-sketch illustration on textured
cream paper, given a gentle Ken Burns drift, with the quote drawn as handwritten
lettering in a reserved area of the frame.

> **Nothing publishes by default.** Publishing requires four independent flags to
> agree. Out of the box you get a full dry run that produces every asset and every
> Meta payload while contacting no Meta endpoint at all.

---

## Status

| Area | State |
|---|---|
| Local pipeline (mock providers, real FFmpeg render) | Working end to end |
| Unit / contract / integration tests | 103 passing, no AWS credentials needed |
| CDK synth | Succeeds |
| Bedrock providers | Implemented, **model IDs not configured** — you must pick models available in your account |
| Meta publishing | Implemented, **not verified against a live account** — requires the onboarding in [`docs/meta-onboarding.md`](docs/meta-onboarding.md) |
| Deployment | **Not deployed.** No AWS resources have been created |

---

## Local quick start

Requires Node 20+ and FFmpeg. No AWS account, no credentials, no network.

```bash
npm install                 # also installs a full FFmpeg build for local rendering
npm run fonts:fetch         # downloads Caveat (SIL Open Font Licence 1.1)

npm run render:local        # render one sample Reel + ffprobe verification
npm run dry-run             # run a whole job end to end, with zero Meta calls
npm test                    # unit + contract + integration
```

`npm run render:local` writes to `.local/render/` and prints the ffprobe report.
`npm run dry-run` additionally writes `meta-payloads.json` — the exact requests
that *would* have been sent to Meta, so you can inspect them before ever going
live.

### All commands

| Command | What it does |
|---|---|
| `npm run lint` | ESLint across every workspace |
| `npm run typecheck` | `tsc --noEmit` across every workspace |
| `npm test` | Full suite (`test:unit`, `test:contract`, `test:integration` also exist) |
| `npm run build` | Typecheck + CDK synth |
| `npm run synth` | CDK synth only |
| `npm run render:local` | Render one sample Reel locally |
| `npm run dry-run` | Full job, mocked providers, no external calls |
| `npm run seed` | Generate a day of quotes to inspect variety and dedupe |
| `npm run admin -- <action>` | Inspect jobs, resolve reviews, retry safely |
| `npm run fonts:fetch` | Download the handwritten font + its licence |

---

## What is mocked versus real

| Component | Local (`PROVIDER_MODE=mock`) | Deployed (`PROVIDER_MODE=bedrock`) |
|---|---|---|
| Quote + caption | Deterministic phrase bank | Bedrock text model (Converse API) |
| Illustration | Procedurally drawn PNG (pure TypeScript, no network) | Bedrock image model |
| Image validation | Geometry, contrast, reserved-area ink density | The same **plus** Rekognition OCR and moderation |
| Render | **Real FFmpeg** — the actual production filter graph | The same code in a Lambda container image |
| `ffprobe` validation | **Real** | **Real** |
| Storage | Local filesystem | S3 (private, KMS, versioned) |
| Job state | In-memory, with the same conditional-write semantics | DynamoDB single table |
| Publishing | `DryRunPublisher` — builds real payloads, sends nothing | Meta Graph API |

The render path is genuinely the same code locally and in AWS. That is
deliberate: rendering is where the product lives, so it is not simulated.

---

## Architecture overview

```
EventBridge Scheduler (timezone-aware)
        │
        ▼
  BatchTrigger ──► Step Functions Standard state machine
                          │
                   PrepareContent   (one Lambda: create job, quote,
                          │          image ⇄ validate loop inside)
                          ▼
                     RenderReel  (Lambda container, FFmpeg)
                          ▼
                    ValidateVideo (same image, ffprobe)
                          ▼
                   ScheduleOrPublish
                     │        │
              (in window)  (deferred → durable Wait until the window opens)
                          ▼
                 ┌─────── Parallel ───────┐
                 │                        │
        PublishInstagram          PublishFacebook
        create→poll→publish       start→poll→finish
                 └─────── Complete ───────┘
```

Instagram and Facebook are **separate publication transactions**. Either can
succeed while the other fails; the job then finishes `PARTIALLY_COMPLETED`
rather than falsely claiming success.

Full detail, including failure modes and recovery:
[`docs/architecture.md`](docs/architecture.md).

---

## Repository layout

```
infra/       CDK v2 app — foundation, compute, workflow, observability stacks
services/
  shared/    config, errors, logging, redaction, idempotency, DynamoDB repos
  providers/ QuoteGenerator | ImageGenerator | ImageValidator | CaptionGenerator
             | MusicProvider | SocialPublisher — mock, Bedrock and Meta impls
  handlers/  one handler per state machine state, admin commands, local runner
renderer/    FFmpeg argv builder, ffprobe validation, Dockerfile, fonts
config/      per-environment non-secret defaults
scripts/     local-render, dry-run, seed, admin, fetch-fonts
tests/       unit | contract | integration | snapshots
docs/        architecture, Meta onboarding, music rights, operations, decisions
```

---

## Safety model

Four independent conditions must **all** hold before a single byte reaches Meta:

1. `ALLOW_PRODUCTION_PUBLISH=true`
2. `ENVIRONMENT=prod`
3. `PUBLISH_MODE` is `manual_approval` or `auto_publish`
4. the SSM kill switch is disengaged

Fail any one and `createPublisher` returns `DryRunPublisher`, which builds the
real request and sends nothing. There is no other code path to a live call.

Additionally:

- Access tokens travel as `Authorization` headers, never in URLs, and every
  response is redacted before it is logged or persisted.
- S3 is private with block-public-access; Meta ingestion uses a short-lived
  pre-signed URL and nothing else.
- Each Lambda group has its own least-privilege role scoped to specific S3 key
  prefixes. No role can both write source images and read the Meta secret.
- Music is silent unless you supply an owned/licensed track **and** a licence
  reference — see [`docs/music-rights.md`](docs/music-rights.md).
- AI-generated spelling is never trusted: `QUOTE_RENDER_MODE` defaults to
  `overlay`, so FFmpeg draws the authoritative text.

---

## Deployment prerequisites

**Do not deploy yet.** Work through [`docs/TODO.md`](docs/TODO.md) first. In short:

1. Choose Bedrock text and image models **that are enabled in your account and
   region**, and set `BEDROCK_TEXT_MODEL_ID` / `BEDROCK_IMAGE_MODEL_ID`. Nothing
   is hardcoded, because availability varies per account.
2. Complete the Meta app, permissions and app-review work in
   [`docs/meta-onboarding.md`](docs/meta-onboarding.md), then populate the
   Secrets Manager secret out of band.
3. Decide on music: silent (default) or an owned/licensed track with evidence.
4. `cdk bootstrap`, build and push the renderer image to ECR, then deploy the
   stacks. The renderer image is referenced by tag rather than built during
   synth — see [`docs/decisions.md`](docs/decisions.md).

Deploying creates paid AWS resources (DynamoDB, S3, KMS, Lambda, Step Functions,
ECR). The default region is `ap-southeast-2`.

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — diagrams, state machine, failure modes
- [`docs/data-model.md`](docs/data-model.md) — DynamoDB key patterns and access patterns
- [`docs/meta-onboarding.md`](docs/meta-onboarding.md) — Meta app setup and its caveats
- [`docs/music-rights.md`](docs/music-rights.md) — what counts as licence evidence
- [`docs/operations.md`](docs/operations.md) — runbook, alarms, rotation, kill switch
- [`docs/decisions.md`](docs/decisions.md) — why Lambda+FFmpeg, and when to move
- [`docs/TODO.md`](docs/TODO.md) — everything left before going live
