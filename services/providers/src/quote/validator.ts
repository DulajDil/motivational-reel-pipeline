import { jaccardSimilarity, normaliseQuote } from '@mrp/shared';

/**
 * Deterministic quote gate.
 *
 * The LLM is treated as untrusted: every line it produces must survive these
 * checks before it can reach a render. Nothing here calls a model, so the rules
 * are testable, cheap and identical in every environment.
 */

export interface QuoteValidationOptions {
  minWords: number;
  maxWords: number;
  /** Lines published recently; a near-duplicate is rejected. */
  recentQuotes: string[];
  /** Token-set similarity above which two lines count as duplicates. */
  similarityThreshold?: number;
}

export interface QuoteValidationResult {
  valid: boolean;
  failures: string[];
  wordCount: number;
  maxSimilarity: number;
}

/** Claims we must never make. Deliberately broad; false positives are cheap. */
const PROHIBITED_PATTERNS: Array<{ pattern: RegExp; failure: string }> = [
  {
    pattern:
      /\b(cure|cures|heal|heals|healing|diagnos\w*|therapy|therapist|depress\w*|anxiet\w*|anxious|suicid\w*|trauma|medication|prescri\w*|symptom\w*|disorder)\b/i,
    failure: 'medical_or_mental_health_claim',
  },
  {
    pattern:
      /\b(invest\w*|profit\w*|income|wealth|rich|money|crypto|stocks?|trading|returns?|financial\w*)\b/i,
    failure: 'financial_claim',
  },
  { pattern: /\b(legal|lawyer|attorney|lawsuit|sue|contract law)\b/i, failure: 'legal_claim' },
  {
    pattern: /\b(guarantee\w*|guaranteed|will definitely|always works|never fails|100%|proven to)\b/i,
    failure: 'guaranteed_outcome',
  },
  {
    pattern:
      /\b(vote|voting|election|government|president|prime minister|party|political|protest|regime)\b/i,
    failure: 'political_content',
  },
  {
    pattern: /\b(sex\w*|nude|naked|erotic|porn\w*)\b/i,
    failure: 'sexual_content',
  },
  {
    pattern:
      /\b(hate|kill|murder|die|death|worthless|stupid|idiot|loser|pathetic|useless people)\b/i,
    failure: 'hostile_or_harmful_language',
  },
];

/** Compact profanity list; extend via the review queue rather than guessing. */
const PROFANITY = [
  'fuck',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'cunt',
  'dick',
  'piss',
  'slut',
  'whore',
];

/**
 * Attribution markers. Unattributed original lines are the default; anything
 * that looks like a quotation of a named person is rejected because we cannot
 * verify the licence or the attribution.
 */
const ATTRIBUTION_PATTERNS: RegExp[] = [
  /["“”].+["“”]/, // wrapped in quotation marks
  /\s[-—–]\s*[A-Z][a-z]+\s+[A-Z][a-z]+/, // "- Firstname Lastname"
  /\b(said|says|wrote|according to|as .* once said)\b/i,
];

const countWords = (text: string): number =>
  normaliseQuote(text).split(' ').filter(Boolean).length;

export const validateQuote = (
  quote: string,
  options: QuoteValidationOptions,
): QuoteValidationResult => {
  const failures: string[] = [];
  const trimmed = quote.trim();
  const wordCount = countWords(trimmed);
  const threshold = options.similarityThreshold ?? 0.6;

  if (trimmed.length === 0) failures.push('empty');
  if (wordCount < options.minWords) failures.push(`too_short:${wordCount}<${options.minWords}`);
  if (wordCount > options.maxWords) failures.push(`too_long:${wordCount}>${options.maxWords}`);

  if (/\p{Extended_Pictographic}/u.test(trimmed)) failures.push('contains_emoji');
  if (trimmed.includes('#')) failures.push('contains_hashtag');
  if (/https?:\/\//i.test(trimmed)) failures.push('contains_url');
  if (/\n/.test(trimmed)) failures.push('multiline');

  const lowered = trimmed.toLowerCase();
  if (PROFANITY.some((word) => new RegExp(`\\b${word}`, 'i').test(lowered))) {
    failures.push('profanity');
  }

  for (const rule of PROHIBITED_PATTERNS) {
    if (rule.pattern.test(trimmed)) failures.push(rule.failure);
  }

  if (ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    failures.push('looks_attributed');
  }

  let maxSimilarity = 0;
  for (const recent of options.recentQuotes) {
    const similarity = jaccardSimilarity(trimmed, recent);
    if (similarity > maxSimilarity) maxSimilarity = similarity;
  }
  if (maxSimilarity >= threshold) {
    failures.push(`too_similar:${maxSimilarity.toFixed(2)}`);
  }

  return { valid: failures.length === 0, failures, wordCount, maxSimilarity };
};
