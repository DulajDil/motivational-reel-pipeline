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
REFERENCE_SIMILARITY_STRENGTH=0.4
```

`similarityStrength` is the dial that matters. Too low and the style drifts; too
high and the model reproduces the reference instead of illustrating a new scene.
**Start at 0.4, generate a dozen, and look at them.**

The reference must live in the same bucket the generation role is scoped to; a
mismatch is a hard configuration error rather than a silent cross-account read.

## Model choice

Checked against the live Bedrock API on 2026-08-15, in `ap-southeast-2` and
`us-east-1`:

| Model | On Bedrock? | Notes |
|---|---|---|
| `openai.gpt-5.6-luna` | **Yes**, both regions, TEXT output | Works today with zero code change |
| `gpt-image-2` | **No** — not present in any region checked | Would need a direct OpenAI provider |
| `amazon.nova-canvas-v1:0` | Yes, `us-east-1` only | $0.06/image; no image models at all in `ap-southeast-2` |

So the text recommendation lands cleanly:

```bash
BEDROCK_TEXT_MODEL_ID=openai.gpt-5.6-luna   # stays in ap-southeast-2
```

The image recommendation does not. Two options:

**A. Nova Canvas on Bedrock (implemented).** Set `BEDROCK_IMAGE_MODEL_ID=amazon.nova-canvas-v1:0`
and `BEDROCK_IMAGE_REGION=us-east-1`. Reference conditioning is wired through
`IMAGE_VARIATION`. No new vendor, no new credential, same IAM story.

> The `IMAGE_VARIATION` parameter names and their exact behaviour must be
> validated against the current Nova Canvas documentation before production. A
> variation task can reproduce the reference rather than restyle a new scene if
> `similarityStrength` is too high.

**B. gpt-image-2 direct from OpenAI (not implemented).** Genuinely better at
style-matched, repeatedly-editable illustration, which is what this project wants.
The cost is a new provider implementation, an OpenAI API key in Secrets Manager, a
second vendor relationship, and image data egressing to a non-AWS endpoint. The
`ImageGenerator` port already accepts `referenceImage`, so the implementation
would be one new class — but it is a decision, not a detail.

## Tuning checklist

Work in this order; stop as soon as it looks right.

1. `npm run render:local -- "Your quote here"` — check typography, centring, the
   rule, and that long quotes still fit. This needs no model and no credentials.
2. Generate a dozen illustrations with the reference set and lay them side by
   side. Consistency problems are obvious in a grid and invisible one at a time.
3. If style drifts → raise `REFERENCE_SIMILARITY_STRENGTH`.
   If frames look like copies of the reference → lower it.
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
