import { mulberry32 } from '@mrp/shared';

import { PROMPT_VERSIONS } from '../prompts.js';
import type { GeneratedQuote, QuoteGenerator, QuoteRequest } from '../types.js';

/**
 * Deterministic mock generator.
 *
 * Composes lines from small vocabularies so local dry runs produce varied but
 * reproducible content with no model call and no credentials. Every line is
 * written to pass `validateQuote`.
 */
const OPENERS = [
  'Start small and keep the promise you made to yourself',
  'Move gently through today and let the work be enough',
  'Begin again as many times as the morning allows',
  'Choose the quiet effort over the loud intention',
  'Let steady hands finish what a restless mind began',
  'Trust the slow work that no one claps for',
  'Return to the simple task and let it hold you',
  'Give today one honest hour and let that be plenty',
];

const SCENES = [
  'a person sitting cross-legged by a wide window, a mug resting on the sill',
  'a walker pausing on a hillside path with a small satchel over one shoulder',
  'a figure at a plain wooden desk, one hand resting on an open notebook',
  'someone kneeling in a small garden bed, palms open around a seedling',
  'a person leaning on a harbour railing watching a single boat drift',
  'a figure stretching slowly at the foot of a made bed in early light',
];

export class MockQuoteGenerator implements QuoteGenerator {
  public constructor(private readonly modelId = 'mock-text-v1') {}

  public async generate(request: QuoteRequest): Promise<GeneratedQuote> {
    const random = mulberry32(request.seed);
    const avoid = new Set(request.avoidPhrases.map((phrase) => phrase.toLowerCase().trim()));

    let text = OPENERS[Math.floor(random() * OPENERS.length)] ?? OPENERS[0]!;
    // Walk the list rather than resampling so this always terminates.
    for (let offset = 0; offset < OPENERS.length && avoid.has(text.toLowerCase()); offset += 1) {
      text = OPENERS[(OPENERS.indexOf(text) + 1) % OPENERS.length]!;
    }

    const sceneConcept = SCENES[Math.floor(random() * SCENES.length)] ?? SCENES[0]!;

    return {
      text,
      sceneConcept,
      safetyRationale:
        'Mock generator: line is drawn from a fixed, pre-reviewed vocabulary containing no claims, no attribution and no sensitive topics.',
      provider: 'mock',
      modelId: this.modelId,
      promptVersion: PROMPT_VERSIONS.quote,
    };
  }
}
