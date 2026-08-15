# TODO before this can publish

Nothing in this list has been done for you. Each section gates the next.

> **Current state: nothing is deployed and nothing can publish.** The pipeline
> runs fully offline with mocked providers. Publishing requires four independent
> flags to agree, and none of them are set.

---

## 1. Decide the basics

- [ ] Confirm the AWS **region**. Default is `ap-southeast-2` (Sydney).
- [ ] Confirm the **account strategy** — the CDK app assumes one account per
      environment. Change `infra/bin/app.ts` if you want separate accounts.
- [ ] Choose the **timezone** and **posting windows**
      (`SCHEDULE_TIMEZONE`, `PUBLISH_WINDOWS`). Defaults are `Pacific/Auckland`
      and three windows a day.
- [ ] Decide the **brand handle** (`BRAND_HANDLE`), or leave it blank for none.

## 2. Choose Bedrock models

Nothing is hardcoded, because model availability differs per account and region.

- [ ] List what is actually enabled:
      ```bash
      aws bedrock list-foundation-models --region ap-southeast-2
      ```
- [ ] Request model access in the Bedrock console for anything not yet enabled.
- [ ] Set `BEDROCK_TEXT_MODEL_ID` — must support the **Converse** API.
- [ ] Set `BEDROCK_IMAGE_MODEL_ID`, and confirm it can produce **1080×1920**.
- [ ] Confirm which request body shape your image model expects and set
      `BedrockImageBodyStyle` (`nova_titan` or `stability`) accordingly.
- [ ] If image models are unavailable in your region, set `BEDROCK_REGION` to one
      where they are, or use a cross-region inference profile.
- [ ] Once confirmed, narrow the `bedrock:InvokeModel` IAM resource in
      `infra/lib/compute-stack.ts` from `*` to the specific model ARNs.

## 3. Meta setup

Follow [`meta-onboarding.md`](meta-onboarding.md) in full. Summary:

- [ ] Facebook Page you administer.
- [ ] Instagram **Professional** account, linked to that Page.
- [ ] Confirm both are **eligible for API Reel publishing** in your country.
- [ ] Create the Meta app; record App ID and App Secret.
- [ ] Identify the exact current permission set for Page + Instagram publishing.
- [ ] Check whether **Business Verification** is required.
- [ ] Prepare and submit **App Review**. Allow real calendar time; expect
      multiple rounds.
- [ ] Obtain a long-lived **Page access token**; verify it with Meta's token
      debugger; record the expiry.
- [ ] Set a rotation reminder ~2 weeks before expiry.
- [ ] Record `INSTAGRAM_ACCOUNT_ID` and `FACEBOOK_PAGE_ID`.
- [ ] **Verify** `META_GRAPH_API_VERSION`, every endpoint in
      `services/providers/src/publisher/payloads.ts`, and every constraint in
      `renderer/src/profiles.ts` against Meta's current documentation.

## 4. Music and fonts

- [ ] Decide: `silent` (default, always safe) or `owned_licensed`.
- [ ] If licensed: read [`music-rights.md`](music-rights.md), gather the
      evidence, upload the track to the private assets bucket, set
      `MUSIC_S3_URI` and `MUSIC_LICENSE_REFERENCE`.
- [ ] `npm run fonts:fetch`, or supply your own font **with its licence file**.
      Confirm it permits embedding in distributed video.

## 5. Deploy

Creates paid AWS resources.

- [ ] `npm run verify` passes (lint, typecheck, tests, synth).
- [ ] `cdk bootstrap aws://<account>/ap-southeast-2`
- [ ] Deploy the foundation stack first — it creates the ECR repository:
      ```bash
      npm run -w infra deploy -- Mrp-dev-Foundation
      ```
- [ ] Build and push the renderer image:
      ```bash
      npm run fonts:fetch
      docker build -f renderer/Dockerfile -t mrp-renderer .
      # tag and push to the ECR repo created above
      ```
- [ ] Deploy the rest with the image tag (pin a **digest** in production):
      ```bash
      npm run -w infra deploy -- --all \
        -c rendererImageTag=<tag> \
        -c alarmEmail=you@example.com
      ```
- [ ] Confirm the SNS alarm subscription email.
- [ ] Populate the Meta secret **out of band** (see onboarding). Never commit it.

## 6. First live publish

Do not skip the ladder.

- [ ] Run with `PUBLISH_MODE=dry_run` in AWS. Confirm assets land in S3 and jobs
      reach a terminal state.
- [ ] Inspect a rendered MP4 by hand. Watch it. Is it something you would post?
- [ ] Switch to `PUBLISH_MODE=manual_approval`, with
      `ALLOW_PRODUCTION_PUBLISH=true` and `ENVIRONMENT=prod`.
- [ ] Approve **one** job. Verify the Reel in both apps.
- [ ] Check the publish receipt in S3 and the `PUB#` items in DynamoDB.
- [ ] Only then consider `auto_publish`, and start at `DAILY_TARGET=1`.
- [ ] Raise volume gradually, watching the Instagram quota metric.

## 7. Operational readiness

- [ ] Confirm the kill switch works **before** you need it:
      ```bash
      aws ssm put-parameter --name /mrp/prod/kill-switch --value true --overwrite
      ```
- [ ] Set an **AWS Budget** with its own alerting. The in-pipeline cost guard is
      a tripwire, not accounting.
- [ ] Read [`operations.md`](operations.md) end to end.
- [ ] Decide who is on call for the manual-review queue.
- [ ] Confirm `retainFinalsDays` and `retainAuditDays` match your retention needs.

---

## Known gaps

Honest list of what is implemented but unproven, or deliberately left out.

- **Meta publishing is unverified against a live account.** The request shapes
  are implemented and contract-tested against a fake `fetch`, but nothing here has
  ever contacted Meta. Expect to adjust `payloads.ts` during onboarding.
- **Bedrock providers are unverified against a live model.** Error classification
  and response parsing are implemented; the image request body shape in
  particular must be confirmed for whichever model you enable.
- **`ValidateVideo` uses the Instagram profile as the base report** and appends
  per-platform failures. The two profiles are currently identical; if you diverge
  them, revisit `renderer/src/validate-handler.ts`.
- **Near-duplicate image detection** is a contrast/ink-density heuristic plus
  Rekognition OCR. There is no perceptual-hash comparison against previous
  images; `maxSimilarity` is always 0 for images.
- **The procedural mock illustration is not art.** It exists so the pipeline can
  be exercised offline. Real output quality depends entirely on your image model
  and prompt.
- **Cost estimation is a flat per-job figure** (`estimateJobCostUsd`). Replace it
  with real per-model pricing if the guard needs to be accurate rather than
  merely protective.
- **No CI pipeline is configured** beyond the GitHub Actions workflow in
  `.github/workflows/`. It runs lint, typecheck, tests and synth; it does not
  build or push the renderer image.
