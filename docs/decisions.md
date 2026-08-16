# Decisions

Short records of choices that were not obvious, and what would change them.

---

## 1. Lambda + FFmpeg container for rendering, not Fargate

**Decision.** Render in a Lambda container image with a static FFmpeg build.

**Why.** The workload is bursty and small: 5–30 renders a day, each a few
seconds of CPU. A local render of a 14-second 1080×1920 Reel takes ~6 seconds
wall-clock. Lambda bills per millisecond, scales from zero, needs no cluster, no
task definitions and no capacity planning, and it fits the Step Functions
integration the rest of the pipeline already uses. Fargate would add a
permanently-running control surface and a minimum billing granularity that this
volume cannot justify.

**Constraints accepted.**
- 15-minute maximum execution (the render function is capped at 10).
- 10 GB `/tmp`, which is ample for one still image, one audio file and one MP4.
- CPU scales with memory, so the function is provisioned at 4 GB for the cores
  rather than the RAM.
- Container image cold starts are slower than a zip; irrelevant for a batch job.

### Move to Fargate (or MediaConvert) when any of these become true

| Threshold | Why it flips the decision |
|---|---|
| A single render exceeds **~10 minutes** | Approaching the Lambda ceiling; no headroom for a slower input |
| Sustained **> 200 renders/day** | Lambda per-ms pricing stops beating a warm task; a queue-driven service amortises better |
| Renders need **> 10 GB** of scratch | Exceeds Lambda's ephemeral storage |
| Video **input** clips are introduced | Multi-input editing changes CPU and I/O profile entirely |
| GPU encoding becomes worthwhile | Not available on Lambda |
| Render p99 latency becomes user-visible | Warm capacity beats cold start |

At 30/day — the stated growth target — none of these are close. Revisit if the
product changes from "one still, one quote" to real video editing. If it becomes
a straight transcode problem rather than a compositing one, **AWS Elemental
MediaConvert** is a better answer than either.

---

## 2. The renderer image is referenced from ECR, not built during `cdk synth`

**Decision.** `DockerImageCode.fromEcr(repo, { tagOrDigest })` rather than
`fromImageAsset`.

**Why.** `fromImageAsset` builds the image during synth, so `cdk synth` requires
a running Docker daemon. That makes `npm run build` fail on any machine or CI
runner without Docker, and couples infrastructure review to an image build. With
ECR the image is built and pushed by CI, and the stack references a tag or digest.

**Trade-off.** The image must exist before deployment, and the tag must be passed
in (`-c rendererImageTag=...`). Pin a **digest** in production so a moved tag
cannot silently change what runs.

---

## 3. Quote overlay in FFmpeg, not generated typography

**Decision.** `QUOTE_RENDER_MODE=overlay` by default. The image model is asked
for an illustration with a **reserved empty area**, and FFmpeg draws the exact
quote into it.

**Why.** Image models misspell. They drop letters, invent glyphs and produce
plausible-looking nonsense at small sizes, and the failure is silent — the image
looks fine at a glance. For a product whose entire payload is a short piece of
text, that is unacceptable. Drawing the text ourselves makes spelling a
non-problem, makes the font a licensing decision we control, and makes layout
deterministic and testable.

`embedded_ai` exists for experimentation and is **refused in production** by
config validation. `hybrid` still draws the authoritative text.

**Cost.** The lettering is typographic rather than truly hand-drawn. A
handwriting-style OFL font (Caveat) closes most of that gap, and the reserved
area is explicitly requested in the prompt so the composition accommodates it.

---

## 4. Single DynamoDB table

See [`data-model.md`](data-model.md) for the full justification. Summary: every
entity is accessed under a job, or through one of three well-defined queues. One
table gives atomic conditional writes across job, publish and idempotency records
without cross-table coordination.

---

## 5. Durable `Wait`, not a scheduler/dispatcher pair

**Decision.** When a render completes outside a posting window, the execution
parks in a Step Functions `Wait` state until `scheduledFor`.

**Why.** The alternative — write a schedule row, run a dispatcher Lambda on a
cron, query due rows, start a second execution — introduces polling, a second
entry point into the publish path, and a whole class of duplicate-dispatch bugs.
A Standard workflow can wait for hours at no cost and with full visibility.

Schedule rows are still written (GSI1) because *querying what is due* is an
operational need, but they are not the dispatch mechanism.

---

## 6. The mock image provider draws a real PNG in pure TypeScript

**Decision.** Hand-written PNG encoder plus a procedural sketch generator, rather
than a committed fixture image or a native image dependency.

**Why.** Tests and dry runs need a real, correctly-sized, deterministic 1080×1920
image. A committed binary would be a licensing question and repository bloat; a
native library (sharp, canvas) is a build dependency on every developer machine
and in CI. ~200 lines of TypeScript over `node:zlib` removes both problems, and
the encoder is round-trip tested.

It also caught a genuine bug: the first implementation over-allocated each PNG
chunk by 4 bytes, producing files that some decoders tolerated and FFmpeg did
not. A committed fixture would have hidden that.

---

## 7. `no-undef` is disabled for TypeScript

ESLint's `no-undef` cannot see TypeScript types, so it flags `NodeJS.ProcessEnv`,
`RequestInit` and similar as undefined. TypeScript already performs that check
properly. Keeping the rule on would mean either a stream of false positives or
maintaining a globals list by hand.

---

## 8. FFmpeg binary resolution with a capability pre-flight

**Decision.** Resolve FFmpeg via `FFMPEG_PATH` → `ffmpeg-static` → `PATH`, and
assert `drawtext` exists before rendering.

**Why.** `drawtext` needs libfreetype, and libharfbuzz on FFmpeg 7.1+. Several
common package-manager builds ship without them — including the Homebrew bottle
on the machine this was developed on. Without the pre-flight the failure is
`No such filter: 'drawtext'` from deep inside a filter graph, minutes in. With
it, the failure is immediate and names the fix.

The Lambda image bakes in a full static build, so this only affects local
development. `ffmpeg-static` is a dev dependency, not shipped.

---

## 9. Errors are a closed taxonomy, and Step Functions owns task retries

Four kinds: `retryable`, `non_retryable`, `manual_review`, `configuration`. The
class names are matched by the state machine, so they are part of the
infrastructure contract.

Task-level retries live in the state machine, with exponential backoff and **full
jitter**. Handlers retry only tight single external calls. Nesting the two would
multiply attempts (3 × 3 = 9) and hide them from the execution history.

Unknown errors default to `retryable`, because a transient blip should not kill a
job permanently — and the state machine bounds attempts, so the default cannot
loop forever.

---

## 10. Content safety is deterministic code, not a model call

**Decision.** `validateQuote` is regex and word-count rules. No model judges the
model.

**Why.** It is testable, free, instant, identical in every environment, and it
cannot itself hallucinate. An LLM safety pass would add latency, cost and a
second source of nondeterminism to a gate whose whole job is to be predictable.
The rules are deliberately broad — false positives cost one regeneration, which
is cheap; a false negative publishes a medical claim to a real audience.

Rekognition moderation *is* used for images, where deterministic rules cannot
reach.

---

## 11. Four generation states merged into one `PrepareContent` Lambda

**Decision.** `CreateJob`, `GenerateQuoteAndMetadata`, `GenerateImage` and
`ValidateImage` were four Step Functions states and four Lambda functions. They
are now one state and one function, with the image regeneration loop as a `for`
loop inside the handler.

**Why.** The only reason the state machine needed a `Choice` there was to loop
back to `GenerateImage` on a rejected image. A Choice whose entire job is "try
again" is a loop written in the most expensive possible notation: it costs state
transitions, it spreads one decision across two files, and it forces the attempt
counter to travel through the state document.

Measured effect on the synthesized template: **33 states to 29**, **18 Lambda
functions to 15**, and the linear happy path — the part you read top to bottom —
from **10 states to 6**.

**What stayed a state, and why.** Everything whose reason for existing is
durability rather than sequencing:

- `RenderReel` — a 4 GB container that must not be held warm while anything waits
- `ValidateVideo` — the terminal gate before publishing
- `WaitForPublishWindow` — an hours-long durable wait no Lambda can hold
- the publish phases — bounded polling plus per-platform failure isolation

**Constraint accepted.** The merged sequence must fit inside a Lambda. Worst case
is quote generation plus `MAX_GENERATION_ATTEMPTS` image attempts. The function
is capped at 14 minutes, and a deadline guard refuses to begin another attempt
without 2 minutes remaining — so it parks the job for review rather than being
killed mid-write. Raising `MAX_GENERATION_ATTEMPTS` much beyond 3, or moving to a
substantially slower image model, is the thing that would break this and force
the states back apart.

**Trade-off.** Failures are now attributable to `PrepareContent` rather than to
one of four named states. The `EVT#` audit trail and the structured logs still
distinguish them, so this cost is paid in the console view only.

---

## 12. Image generation gets its own region

**Decision.** `BEDROCK_IMAGE_REGION` is separate from `BEDROCK_REGION`, and the
provider factory builds a second Bedrock client when they differ.

**Why.** Checked against the live Bedrock API on 2026-08-15:

| Region | Text models | Image-generation models |
|---|---|---|
| `ap-southeast-2` (the stack region) | 61 | **0** |
| `us-east-1` | many | 14, incl. `amazon.nova-canvas-v1:0` |

A single `BEDROCK_REGION` would have forced *both* text and images to us-east-1,
sending text generation across the Pacific for no reason. Splitting them keeps
text local and sends only image generation where the models actually are.

**Cost context, from the Price List API on the same date (ap-southeast-2):**

| Item | Price |
|---|---|
| Step Functions Standard state transition | $0.000025 (4,000/month free) |
| Lambda compute, x86 | $0.0000166667 per GB-second (400,000 GB-s/month free) |
| Nova Canvas image (us-east-1) | $0.06 per image |

At 5 reels/day the pipeline uses ~71,000 Lambda GB-seconds and ~3,450 state
transitions a month - **both inside the perpetual free tier**. The entire
marginal bill is image generation: about **$10/month at 5/day, $63/month at
30/day**, of which Bedrock is 98-100%.

The practical consequence: **orchestration choices here are not cost decisions.**
The four states merged in decision 11 were worth about **9 cents a month** at 30
reels/day. That refactor was about clarity. If cost matters, the lever is the
image model and how often regeneration is triggered - not Step Functions.

---

## 13. Stability Style Guide for illustrations, not Nova Canvas or gpt-image-2

**Decision.** `BEDROCK_IMAGE_MODEL_ID=us.stability.stable-image-style-guide-v1:0`
in `us-west-2`, selected by `BEDROCK_IMAGE_BODY_STYLE=stability_style_guide`.
Nova Canvas stays implemented as the `nova_titan` fallback.

**Why.** The brand requirement is "a new scene in an established style". Style
Guide states that as its purpose; Nova Canvas `IMAGE_VARIATION` is a variation
task bent toward it, which is why its conditioning behaviour was flagged as
unverified. A model built for the job beats a model coerced into it.

`gpt-image-2` was recommended externally but is **not on Bedrock in any region** —
every OpenAI model there is TEXT-only (checked 2026-08-16 across
`ap-southeast-2`, `us-east-1`, `us-west-2`). Adopting it means a second vendor,
an API key in Secrets Manager and image data leaving AWS. That is a real option,
but a decision rather than a config change, so it was not taken by default.
`openai.gpt-5.6-luna` *is* on Bedrock in Sydney and is used for text.

**The consequence that mattered.** Stability Image Services size output from an
`aspect_ratio` enum at roughly one megapixel and **cannot be asked for
1080×1920**. An exact-dimension check would have rejected every frame the model
produces. So the validator gained a second mode: with `minHeight` set it enforces
the aspect ratio and a size floor instead of exact pixels, and the renderer scales
to the target as it already did for Ken Burns.

That mode is **derived from the body style**, not exposed as its own switch —
`imageDimensionMode` is computed in `loadConfig`. A separate knob could be set
inconsistently with the model; a derived value cannot.

**Two smaller correctness points, both from the API docs rather than guesswork:**

- The model id needs the **`us.` inference-profile prefix**. The bare
  `stability.…` id that `list-foundation-models` returns will not invoke.
- Stability reports content filtering in `finish_reasons` with an HTTP 200 and no
  image. Unchecked, that reads as success. A filtered prompt is non-retryable —
  it filters identically next time — while an inference error is retryable.

**Still unverified:** no image model has been invoked live, and the Price List API
returned no entry for Style Guide, so its cost is unknown. The $0.06/image figure
in decision 12 is Nova Canvas's and does not transfer.

---

## 14. Illustrations come from OpenAI, not Bedrock

**Decision.** `IMAGE_PROVIDER=openai` with `gpt-image-2` is the production path.
The Bedrock image providers stay implemented and tested as a fallback. Text
generation is unchanged: Bedrock, `ap-southeast-2`.

**Why.** Decision 13 chose Stability Style Guide by reasoning from what the model
is *described* as doing. That reasoning was sound and still lost to a better kind
of evidence: the house style in this repository was established by generating
frames manually with gpt-image, and those frames are already correct. Nothing on
Bedrock has been shown to match them.

Given a model with demonstrated output for this exact brand and a model whose
documentation fits the use case, the demonstrated one wins. The project exists to
automate work already being done well by hand, so the automated path should use
the tool that was doing it.

**What it costs.** This is the only call in the system that leaves AWS. A second
vendor, a second credential, a second bill, and the prompt plus the reference
frame go to `api.openai.com`. Accepted deliberately, with the cost stated rather
than buried.

The blast radius is contained by IAM: the OpenAI key lives in its own secret and
is granted **only** to the generation role, which has no publishing permission.
The publisher role holds the Meta credential and cannot read the OpenAI one.
Neither role can see the other's secret.

**Three properties of the Images API that shaped the implementation:**

- **Sizes must have both edges divisible by 16**, so 1080x1920 is not requestable
  (1080 is not a multiple of 16). `1152x2048` is true 9:16 and *larger* than the
  target, so the renderer scales down rather than up. `loadConfig` rejects an
  illegal or non-9:16 size instead of letting the API fail at run time.
- **There is no `negative_prompt`.** The exclusions are folded into the prompt.
  The reserved area is defended in three places, so this weakens the weakest one.
- **`input_fidelity` is not accepted by gpt-image-2**, which processes image
  inputs at high fidelity automatically. `REFERENCE_SIMILARITY_STRENGTH`
  therefore has no effect on this path; it still applies to the Bedrock ones.

**The key is resolved lazily** through a closure rather than fetched when the
provider is constructed, so the factory stays synchronous and the secret is only
read on a path that actually generates an image.

**Still unverified:** nothing here has called the Images API live. The request
shape is built from current OpenAI documentation and tested against a fake
`fetch`. One further caveat — if the manual frames were made in the ChatGPT app
rather than through the API, the two surfaces differ in prompt handling, and the
first API results may need prompt adjustment to match what was seen by hand.
