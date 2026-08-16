# Brand consistency

The goal: every Reel is recognisably the same series. That is achieved by making
as much of the frame as possible **deterministic**, and constraining the one part
that cannot be.

## What is deterministic, and what is generated

| Layer | Who decides | Varies between Reels? |
|---|---|---|
| Paper tone, ink colour, vignette | [`brand-style.ts`](../services/providers/src/brand-style.ts) | **No** |
| Quote position, size, centring | [`text-layout.ts`](../renderer/src/text-layout.ts) | **No** — same area every frame |
| Font | bundled Patrick Hand (SIL OFL 1.1) | **No** |
| Underline rule | [`ffmpeg-args.ts`](../renderer/src/ffmpeg-args.ts) | **No** |
| Ken Burns motion | seeded from `jobId` | Slightly, within a narrow band |
| **Illustration** | the image model | **Yes** — this is the only free variable |
| Quote text | the text model, then a deterministic gate | Yes |

Everything except the illustration is code. That is the point: consistency is not
something you ask a model for and hope, it is something you compute.

## The style contract

[`services/providers/src/brand-style.ts`](../services/providers/src/brand-style.ts)
is the single source of truth. It is imported by the prompt builder, the renderer
and the procedural stand-in, so those three can never drift apart.

```
RESERVED_TOP_FRACTION   0.35     top third reserved for the quote
BRAND_TEXT_SAFE_AREA    x 0.08, y 0.08, w 0.84, h 0.24
BRAND_TYPOGRAPHY        Patrick Hand, centred, 46-88px, 1.5 line height
                        underline: 62% of block width, 3px, 34px below
BRAND_PALETTE           parchment #F4E2BD, ink #2A2118, rule #3A2E22
BRAND_STYLE_CLAUSE      the wording pasted into every illustration prompt
```

Change a value here and every future Reel changes with it. Nothing else in the
codebase is allowed to hardcode a brand value.

**The quote area no longer varies per job.** It used to alternate between two
positions for variety; that directly undermines the thing a series depends on, so
it is now fixed.

## The reserved area is enforced three times

1. **Prompt** — the illustration prompt demands the top 35% be left as clean
   parchment, with no letters, logos, signature, border or underline.
2. **Validation** — [`validator/local.ts`](../services/providers/src/validator/local.ts)
   measures ink density inside that band against the whole image's paper tone and
   rejects the image if it is not clean. Rekognition OCR adds real text detection
   on top in AWS.
3. **Render** — the quote is drawn by FFmpeg regardless of what the model did, so
   spelling is never the model's problem.

## The reference image

Set `REFERENCE_IMAGE_S3_URI` to an approved frame in the private assets bucket and
it is passed to the image model as a style guide on every generation:

```bash
REFERENCE_IMAGE_S3_URI=s3://mrp-prod-assets-<account>/brand/reference-style.png
REFERENCE_SIMILARITY_STRENGTH=0.5
```

**With `BEDROCK_IMAGE_BODY_STYLE=stability_style_guide` the reference is not
optional** - Style Guide takes it as a required model parameter, so a missing one
is refused at config load rather than silently degrading to a prompt-only run.

The strength is the dial that matters; it is sent as `fidelity` (0..1, model
default 0.5). Too low and the style drifts, too high and the model reproduces the
reference instead of illustrating a new scene. **Start at 0.5, generate a dozen,
and look at them as a grid.**

The reference must live in the same bucket the generation role is scoped to; a
mismatch is a hard configuration error rather than a silent cross-account read.

## Model choice

Checked against the live Bedrock API on 2026-08-16, in `ap-southeast-2`,
`us-east-1` and `us-west-2`:

| Model | On Bedrock? | Notes |
|---|---|---|
| `openai.gpt-5.6-luna` | **Yes**, all three regions, TEXT output | Works today with zero code change |
| `gpt-image-2` | **No** — absent from every region checked | Every OpenAI model on Bedrock is TEXT-only |
| `stability.stable-image-style-guide-v1:0` | Yes, `us-east-1` and `us-west-2` | **Selected.** Purpose-built for this job |
| `amazon.nova-canvas-v1:0` | Yes, `us-east-1` only | $0.06/image; the fallback |

There are no image-generation models of any kind in `ap-southeast-2`, so text and
images run in different regions:

```bash
BEDROCK_TEXT_MODEL_ID=openai.gpt-5.6-luna              # stays in ap-southeast-2
BEDROCK_IMAGE_MODEL_ID=us.stability.stable-image-style-guide-v1:0
BEDROCK_IMAGE_REGION=us-west-2                          # widest Stability set
BEDROCK_IMAGE_BODY_STYLE=stability_style_guide
```

Note the **`us.` prefix** on the image model id: that is the inference profile,
and the bare `stability.…` id returned by `list-foundation-models` will not
invoke.

**Why Style Guide.** It extracts the style of a reference frame and draws a new
scene in it — which is the brand-consistency requirement stated directly, rather
than a variation task bent toward the same end. Nova Canvas `IMAGE_VARIATION`
remains implemented as the fallback (`BEDROCK_IMAGE_BODY_STYLE=nova_titan`), but
its conditioning behaviour is unverified and a high `similarityStrength` will
reproduce the reference rather than restyle.

### The size consequence

Stability Image Services size their output from an `aspect_ratio` enum at roughly
one megapixel. **They cannot be asked for 1080×1920.** Two things follow:

- The validator runs in *aspect* mode: it enforces the 9:16 ratio and a
  `MIN_IMAGE_HEIGHT` floor (default 1280) instead of an exact pixel match. This
  is derived from `BEDROCK_IMAGE_BODY_STYLE`, not a separate switch, so it cannot
  drift out of step with the model.
- The renderer scales the frame to 1080×1920 as it already does for Ken Burns, so
  the delivered MP4 is unchanged.

`finish_reasons` is also checked: Stability reports content filtering with an HTTP
200 and no image, so an unchecked response would read as success. A filtered
prompt is non-retryable (it will filter identically next time); an inference error
is retryable.

**gpt-image-2 remains available as a later move.** It would need a direct OpenAI
provider, an API key in Secrets Manager, a second vendor and image egress off AWS.
The `ImageGenerator` port already accepts `referenceImage`, so it is one new class
— a decision, not a detail.

## Tuning checklist

Work in this order; stop as soon as it looks right.

1. `npm run render:local -- "Your quote here"` — check typography, centring, the
   rule, and that long quotes still fit. This needs no model and no credentials.
2. Generate a dozen illustrations with the reference set and lay them side by
   side. Consistency problems are obvious in a grid and invisible one at a time.
3. If style drifts → raise `REFERENCE_SIMILARITY_STRENGTH`.
   If frames look like copies of the reference → lower it.
   It is sent as `fidelity`; the model's own default is 0.5.
4. If the model keeps drawing into the reserved band → strengthen the negative
   prompt, or raise `RESERVED_TOP_FRACTION`.
5. **Bump `PROMPT_VERSIONS.image` whenever you change prompt wording**, so old
   and new output can be told apart in the audit trail.

## What this does not fix

- **Character consistency.** Nothing here guarantees the same character appears
  across Reels — only the same *style*. A recurring character needs either a much
  higher similarity strength, a fine-tune, or a fixed cast of pre-approved
  character reference images. Not implemented.
- **Perceptual near-duplicate detection.** Two illustrations can be nearly
  identical and both pass validation; `maxSimilarity` is always 0 for images.
- **Colour drift over time.** If you change image models, re-check the palette
  against the reference by eye. Nothing measures it.
- **No image model here has been called live.** The Style Guide request shape is
  built from the current AWS documentation and unit-tested against a fake client,
  but nothing has invoked the real model. Expect to adjust after the first call.
- **Style Guide pricing was not obtainable from the Price List API.** Check the
  Bedrock pricing page before generating in volume; Stability Image Services are
  not priced the same as Nova Canvas's $0.06/image.
