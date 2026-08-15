import { createHash } from 'node:crypto';

export const sha256Hex = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex');

/**
 * Normalise a quote for fingerprinting: case-folded, punctuation-stripped,
 * whitespace-collapsed. Two quotes that differ only in styling collide on
 * purpose so near-duplicates are caught by the dedupe check.
 */
export const normaliseQuote = (quote: string): string =>
  quote
    .toLowerCase()
    .normalize('NFKD')
    // Curly single quotes are apostrophes and carry meaning ("don't").
    .replace(/[‘’]/g, "'")
    // Double quotes are punctuation wrapped around the line, not part of it.
    .replace(/[“”"]/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    // Leading and trailing apostrophes are quoting leftovers, never content.
    .replace(/^'+|'+$/g, '')
    .trim();

export const quoteFingerprint = (quote: string): string => sha256Hex(normaliseQuote(quote));

/**
 * Token-set Jaccard similarity, used as a cheap near-duplicate check against
 * recent history. Deliberately simple: no embeddings call on the hot path.
 */
export const jaccardSimilarity = (a: string, b: string): number => {
  const left = new Set(normaliseQuote(a).split(' ').filter(Boolean));
  const right = new Set(normaliseQuote(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
};
