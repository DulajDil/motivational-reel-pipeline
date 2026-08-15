import {
  ManualReviewRequiredError,
  Metrics,
  NonRetryableError,
  emitMetric,
  quoteFingerprint,
  renderSeed,
  type ContentMetadata,
  type WorkflowState,
} from '@mrp/shared';
import { DEFAULT_TEXT_SAFE_AREAS, validateQuote } from '@mrp/providers';

import { getRuntime, type Runtime } from '../context.js';

/**
 * GenerateQuoteAndMetadata.
 *
 * The model is untrusted. Every candidate line must pass the deterministic gate
 * in `validateQuote` and then win a conditional write on its fingerprint, which
 * is what actually prevents two jobs racing to publish the same words.
 *
 * Attempts are bounded; persistent failure goes to manual review rather than
 * looping.
 */
export const generateQuoteAndMetadata = async (
  state: WorkflowState,
  runtime: Runtime = getRuntime(),
): Promise<WorkflowState> => {
  const { config, repository, providers, logger } = runtime;
  const log = logger.child({ jobId: state.jobId, state: 'GenerateQuoteAndMetadata' });

  const job = await repository.getJob(state.jobId);
  if (!job) throw new NonRetryableError(`Job ${state.jobId} not found`);
  if (job.content) {
    log.info('Content already generated, skipping');
    return { ...state, status: job.status };
  }

  const recent = await repository.recentQuotes(60);
  const recentTexts = recent.map((entry) => entry.text);
  const seed = renderSeed(state.jobId);

  const rejections: string[][] = [];
  let accepted:
    | { text: string; fingerprint: string; wordCount: number; generated: Awaited<ReturnType<typeof providers.quote.generate>> }
    | undefined;

  for (let attempt = 0; attempt < config.MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const generated = await providers.quote.generate({
      jobId: state.jobId,
      avoidPhrases: recentTexts.slice(0, 25),
      minWords: config.QUOTE_MIN_WORDS,
      maxWords: config.QUOTE_MAX_WORDS,
      seed: seed + attempt,
    });

    const validation = validateQuote(generated.text, {
      minWords: config.QUOTE_MIN_WORDS,
      maxWords: config.QUOTE_MAX_WORDS,
      recentQuotes: recentTexts,
    });

    if (!validation.valid) {
      rejections.push(validation.failures);
      emitMetric(Metrics.quotesRejected, 1, {
        Environment: config.ENVIRONMENT,
        Reason: validation.failures[0] ?? 'unknown',
      });
      log.warn('Quote rejected', { attempt, failures: validation.failures });
      continue;
    }

    const fingerprint = quoteFingerprint(generated.text);
    const reserved = await repository.reserveContentFingerprint(
      fingerprint,
      generated.text,
      state.jobId,
      60 * 60 * 24 * config.QUOTE_DEDUPE_WINDOW_DAYS,
    );
    if (!reserved) {
      rejections.push(['fingerprint_already_used']);
      log.warn('Quote fingerprint already reserved', { attempt });
      continue;
    }

    accepted = { text: generated.text, fingerprint, wordCount: validation.wordCount, generated };
    break;
  }

  if (!accepted) {
    throw new ManualReviewRequiredError(
      `No acceptable quote after ${config.MAX_GENERATION_ATTEMPTS} attempts`,
      'quote_generation_exhausted',
      { context: { rejections } },
    );
  }

  const caption = await providers.caption.generate({
    jobId: state.jobId,
    quote: accepted.text,
    sceneConcept: accepted.generated.sceneConcept,
    brandHandle: config.BRAND_HANDLE,
  });

  // Alternate the reserved area deterministically so the feed does not look
  // mechanically identical day to day.
  const textSafeArea =
    seed % 2 === 0 ? DEFAULT_TEXT_SAFE_AREAS.upper_left : DEFAULT_TEXT_SAFE_AREAS.upper_middle;

  const content: ContentMetadata = {
    quote: {
      text: accepted.text,
      fingerprint: accepted.fingerprint,
      wordCount: accepted.wordCount,
      provider: accepted.generated.provider,
      modelId: accepted.generated.modelId,
      promptVersion: accepted.generated.promptVersion,
      createdAt: runtime.clock().toISOString(),
      safetyRationale: accepted.generated.safetyRationale,
    },
    sceneConcept: accepted.generated.sceneConcept,
    caption: caption.caption,
    altText: caption.altText,
    hashtags: caption.hashtags,
    textSafeArea,
  };

  await repository.updateJob(state.jobId, { content, status: 'QUOTE_READY' }, [
    'CREATED',
    'QUOTE_READY',
  ]);
  await repository.appendEvent(state.jobId, {
    at: runtime.clock().toISOString(),
    type: 'QUOTE_ACCEPTED',
    actor: 'workflow',
    detail: {
      fingerprint: accepted.fingerprint,
      wordCount: accepted.wordCount,
      provider: accepted.generated.provider,
      modelId: accepted.generated.modelId,
      promptVersion: accepted.generated.promptVersion,
      rejectedAttempts: rejections.length,
    },
  });

  emitMetric(Metrics.quotesGenerated, 1, { Environment: config.ENVIRONMENT });
  log.info('Quote accepted', { fingerprint: accepted.fingerprint, attempts: rejections.length + 1 });

  return { ...state, status: 'QUOTE_READY', generationAttempts: 0 };
};

// No Lambda entry point: this step runs inside PrepareContent.
