import { describe, expect, it } from 'vitest';

import { validateQuote } from '@mrp/providers';

const options = { minWords: 6, maxWords: 18, recentQuotes: [] as string[] };

const failuresFor = (quote: string, overrides = {}): string[] =>
  validateQuote(quote, { ...options, ...overrides }).failures;

describe('validateQuote', () => {
  it('accepts a plain original line', () => {
    const result = validateQuote('Start small and keep the promise you made to yourself', options);
    expect(result.valid).toBe(true);
    expect(result.wordCount).toBe(10);
  });

  it.each([
    ['Too short here', 'too_short'],
    [
      'This line rambles on and on and on and on and on and on and on and on and on forever',
      'too_long',
    ],
  ])('enforces word count: %s', (quote, expected) => {
    expect(failuresFor(quote).some((failure) => failure.startsWith(expected))).toBe(true);
  });

  it.each([
    ['This will cure your anxiety and heal you today', 'medical_or_mental_health_claim'],
    ['Invest today and your wealth will grow steadily', 'financial_claim'],
    ['This method is guaranteed to work for everyone always', 'guaranteed_outcome'],
    ['Go and vote for the party that will save us', 'political_content'],
    ['Get legal advice before you sue them for this', 'legal_claim'],
  ])('rejects prohibited claims: %s', (quote, expected) => {
    expect(failuresFor(quote)).toContain(expected);
  });

  it('rejects anything that looks like an attributed quotation', () => {
    expect(failuresFor('Keep going and never stop moving - Winston Churchill')).toContain(
      'looks_attributed',
    );
    expect(failuresFor('"Keep going and never ever stop moving forward now"')).toContain(
      'looks_attributed',
    );
    expect(failuresFor('As someone once said keep moving forward every day')).toContain(
      'looks_attributed',
    );
  });

  it('rejects emoji, hashtags and links', () => {
    expect(failuresFor('Start small and keep going today my friend 🌱')).toContain('contains_emoji');
    expect(failuresFor('Start small and keep going today #motivation')).toContain(
      'contains_hashtag',
    );
    expect(failuresFor('Start small and keep going https://example.com today')).toContain(
      'contains_url',
    );
  });

  it('rejects near-duplicates of recent lines', () => {
    const result = validateQuote('Start small and keep the promise you made to yourself', {
      ...options,
      recentQuotes: ['start small and keep the promise you made yourself'],
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((failure) => failure.startsWith('too_similar'))).toBe(true);
    expect(result.maxSimilarity).toBeGreaterThan(0.6);
  });

  it('allows a genuinely different line alongside recent history', () => {
    const result = validateQuote('Let steady hands finish what a restless mind began', {
      ...options,
      recentQuotes: ['Start small and keep the promise you made to yourself'],
    });
    expect(result.valid).toBe(true);
  });
});
