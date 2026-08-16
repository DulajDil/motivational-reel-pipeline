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
      `openai.gpt-5.6-luna` was confirmed available in `ap-southeast-2` on
      2026-08-15 and is a good default.
- [ ] Set `BEDROCK_IMAGE_MODEL_ID` to
      `us.stability.stable-image-style-guide-v1:0`. **Keep the `us.` prefix** —
      it is the inference profile, and the bare id from `list-foundation-models`
      will not invoke.
- [ ] Set `BEDROCK_IMAGE_BODY_STYLE=stability_style_guide` to match that model.
      The shape cannot be inferred; a mismatch is a `ValidationException`.
- [ ] **Set `BEDROCK_IMAGE_REGION=us-west-2`.** Checked against the live Bedrock
      API on 2026-08-16: `ap-southeast-2` exposes **61 text models and ZERO
      image-generation models**; `us-east-1` exposes 14 and `us-west-2` exposes
      16. Text can stay in Sydney; image generation cannot. Re-verify in *your*
      account — model access is granted per account, and this was checked in a
      different one.
- [ ] Subscribe to Stability AI Image Services in the Bedrock console. Subscribing
      to any one of the thirteen enrols you in all of them.
- [ ] Look up Style Guide's price before generating in volume. The Price List API
      had no entry for it; do not assume Nova Canvas's $0.06/image applies.
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

## 3b. Brand consistency

Read [`brand-consistency.md`](brand-consistency.md) first.

- [ ] Export one approved frame as the style reference and upload it to
      `s3://<assets-bucket>/brand/reference-style.png`. **This is mandatory** with
      `stability_style_guide`: the model takes the reference as a required
      parameter, and config load refuses to start without it.
- [ ] Set `REFERENCE_IMAGE_S3_URI` and start `REFERENCE_SIMILARITY_STRENGTH` at
      0.5 (sent as `fidelity`; the model's own default).
- [ ] Generate a dozen illustrations and view them **as a grid**. Drift is
      invisible one frame at a time.
- [ ] `gpt-image-2` is **not on Bedrock** in any region — every OpenAI model there
      is TEXT-only. Adopting it later means a direct OpenAI provider, an API key
      in Secrets Manager and a second vendor.

## 4. Music and fonts

- [ ] Decide: `silent` (default, always safe) or `owned_licensed`.
- [ ] If licensed: read [`music-rights.md`](music-rights.md), gather the
      evidence, upload the track to the private assets bucket, set
      `MUSIC_S3_URI` and `MUSIC_LICENSE_REFERENCE`.
- [ ] `npm run fonts:fetch` — installs **Patrick Hand** (SIL OFL 1.1), the
      closest match to the reference lettering. `FONT_NAME=Kalam ... npm run
      fonts:fetch` switches to the slightly more polished alternative.

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
- **Character consistency is not solved.** The style contract keeps paper,
  palette, typography and composition identical, but nothing guarantees the same
  *character* recurs across Reels. That needs a fixed cast of character
  references or a fine-tune.
- **No image model has been called live.** The Stability Style Guide request shape
  is built from current AWS documentation and unit-tested against a fake client;
  nothing has invoked a real image model. Nova Canvas `IMAGE_VARIATION` remains
  the unverified fallback path.
- **Stability Style Guide pricing is unknown.** The Price List API returned no
  match for it. Check the Bedrock pricing page before generating in volume — the
  $0.06/image figure quoted elsewhere in these docs is Nova Canvas's, not this
  model's.
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
