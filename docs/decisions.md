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
