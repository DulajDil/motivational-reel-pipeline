import type { QuoteRenderMode, TextSafeArea } from '@mrp/shared';

/**
 * Prompt library.
 *
 * Versions are persisted with every generated asset so output can be traced back
 * to the exact prompt that produced it. Bump the version whenever wording changes.
 */
export const PROMPT_VERSIONS = {
  quote: 'quote-2025-01-a',
  caption: 'caption-2025-01-a',
  image: 'image-2025-01-a',
} as const;

export const DEFAULT_TEXT_SAFE_AREAS: Record<TextSafeArea['position'], TextSafeArea> = {
  upper_left: { position: 'upper_left', x: 0.08, y: 0.1, width: 0.62, height: 0.26 },
  upper_middle: { position: 'upper_middle', x: 0.1, y: 0.1, width: 0.8, height: 0.26 },
  lower_left: { position: 'lower_left', x: 0.08, y: 0.62, width: 0.62, height: 0.26 },
};

export const describeSafeArea = (area: TextSafeArea): string =>
  `the ${area.position.replace('_', ' ')} of the frame (roughly ${Math.round(area.width * 100)}% wide and ${Math.round(
    area.height * 100,
  )}% tall, starting ${Math.round(area.x * 100)}% from the left and ${Math.round(area.y * 100)}% from the top)`;

export const QUOTE_SYSTEM_PROMPT = `You write short, original motivational lines for a calm, hand-drawn illustration series.

Hard rules:
- Write ORIGINAL lines. Never quote, paraphrase or attribute a line to any real person, book, film, song or brand.
- No medical, legal, financial or mental-health advice or claims of any kind.
- No promises of guaranteed outcomes, income, healing or success.
- No profanity, hate, sexual content, politics, religion or persuasion.
- No brand names, trademarks, celebrities or copyrighted characters.
- Plain, warm, everyday language. Present tense. No emoji, no hashtags, no quotation marks.
- The line must stand alone without context and must not name a specific person.

Also propose ONE illustration concept for the line. The illustration must contain NO text,
NO lettering, NO logos and NO signatures. Describe only the scene: a simple, original,
emotionally clear composition with an expressive but generic human figure, sparse background,
and plenty of empty space.

Respond with a single JSON object and nothing else:
{"quote": string, "sceneConcept": string, "safetyRationale": string}`;

export const buildQuoteUserPrompt = (input: {
  minWords: number;
  maxWords: number;
  avoidPhrases: string[];
  seed: number;
}): string => {
  const avoid =
    input.avoidPhrases.length > 0
      ? `\n\nDo NOT reuse, rephrase or echo any of these recently published lines:\n${input.avoidPhrases
          .map((phrase) => `- ${phrase}`)
          .join('\n')}`
      : '';
  return `Write one motivational line of ${input.minWords}-${input.maxWords} words.
Variation token (use it to pick a different angle, do not mention it): ${input.seed}.${avoid}`;
};

export const CAPTION_SYSTEM_PROMPT = `You write social captions for a calm, hand-drawn motivational illustration series.

Rules:
- The caption must not contradict or restate the quote word for word.
- No claims, no advice, no promises, no emoji spam (at most two emoji).
- 5-8 hashtags, lowercase, generic, no branded or trending-jacking tags.
- Alt text must describe the illustration factually for a screen reader in one sentence.

Respond with a single JSON object and nothing else:
{"caption": string, "altText": string, "hashtags": string[]}`;

/**
 * Illustration prompt.
 *
 * The image model is asked for artwork ONLY. Even in hybrid mode the quote is
 * never relied on for spelling - FFmpeg draws the authoritative text - so the
 * prompt always demands a clean, reserved area rather than lettering.
 */
export const buildImagePrompt = (input: {
  sceneConcept: string;
  textSafeArea: TextSafeArea;
  quoteRenderMode: QuoteRenderMode;
}): string => {
  const lettering =
    input.quoteRenderMode === 'embedded_ai'
      ? 'Hand-drawn pencil lettering may appear in the reserved area, but it must remain simple and uncluttered.'
      : 'The reserved area must contain NO text, NO lettering and NO marks of any kind - it stays clean paper.';

  return [
    `A warm, calm, hand-drawn pencil-sketch illustration on textured cream paper. ${input.sceneConcept}`,
    'Style: black ink outlines, restrained sepia and soft orange shading, visible pencil grain and paper texture, sparse background, generous empty space, uplifting and peaceful mood.',
    'The human figure is expressive but generic: no identifiable face, no real person, no celebrity.',
    `Composition: vertical 9:16 portrait. Leave ${describeSafeArea(input.textSafeArea)} deliberately empty and uncluttered.`,
    lettering,
    'Simple, original, emotionally clear composition. Avoid visual clutter.',
  ].join('\n');
};

export const IMAGE_NEGATIVE_PROMPT = [
  'text',
  'words',
  'letters',
  'typography',
  'caption',
  'watermark',
  'signature',
  'logo',
  'brand',
  'trademark',
  'celebrity',
  'recognisable face',
  'copyrighted character',
  'photorealistic',
  'busy background',
  'clutter',
  'frame',
  'border',
  'colour saturation',
].join(', ');
