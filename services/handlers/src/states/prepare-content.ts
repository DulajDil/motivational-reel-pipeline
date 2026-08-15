import { ManualReviewRequiredError, NonRetryableError } from '@mrp/shared';

import { getRuntime, type Runtime } from '../context.js';
import { createJob, type CreateJobInput } from './create-job.js';
import { generateImage } from './generate-image.js';
import { generateQuoteAndMetadata } from './generate-quote.js';
import { validateImage, type ValidateImageResult } from './validate-image.js';

/**
 * PrepareContent.
 *
 * One state covering everything up to "we have a validated illustration":
 * CreateJob, GenerateQuoteAndMetadata, then the bounded GenerateImage /
 * ValidateImage loop.
 *
 * These four were separate Step Functions states. They were merged because the
 * loop between the last two is the only reason the state machine needed a Choice
 * there, and a Choice whose sole job is "try again" is cheaper and clearer as a
 * `for` loop. The steps that genuinely need to be states - the render, the
 * hours-long wait for a posting window, and the publish phases - stayed put.
 *
 * The merge is only safe because the whole sequence fits inside a Lambda:
 * quote generation plus at most MAX_GENERATION_ATTEMPTS image attempts. The
 * deadline guard below enforces that rather than assuming it.
 */

/** Refuse to start another attempt without at least this much time left. */
const MIN_ATTEMPT_HEADROOM_MS = 120_000;

export interface PrepareContentOptions {
  /**
   * Milliseconds left before the Lambda is killed. Supplied from the Lambda
   * context in AWS; unbounded locally and in tests.
   */
  remainingTimeMs?: () => number;
}

/**
 * PrepareContent ends exactly where ValidateImage used to, so it returns what
 * that step returned rather than declaring an identical shape alongside it.
 */
export type PrepareContentResult = ValidateImageResult;

export const prepareContent = async (
  input: CreateJobInput,
  runtime: Runtime = getRuntime(),
  options: PrepareContentOptions = {},
): Promise<PrepareContentResult> => {
  const { config, logger } = runtime;
  const remainingTimeMs = options.remainingTimeMs ?? (() => Number.POSITIVE_INFINITY);

  let state = await createJob(input, runtime);
  const log = logger.child({ jobId: state.jobId, state: 'PrepareContent' });

  // An already-completed job short-circuits the whole workflow.
  if (state.alreadyComplete) {
    log.info('Job already complete; skipping content preparation');
    return { ...state, imageValid: true, imageFailures: [] };
  }

  state = await generateQuoteAndMetadata(state, runtime);

  for (let attempt = 0; attempt < config.MAX_GENERATION_ATTEMPTS; attempt += 1) {
    // Stop before the runtime kills us mid-generation: a job parked for review
    // is recoverable, a Lambda timeout mid-write is messier.
    if (remainingTimeMs() < MIN_ATTEMPT_HEADROOM_MS) {
      throw new ManualReviewRequiredError(
        'Ran out of Lambda time budget before the image could be validated',
        'generation_time_budget_exhausted',
        { context: { attempt, remainingTimeMs: remainingTimeMs() } },
      );
    }

    state = await generateImage(state, runtime);
    const validated = await validateImage(state, runtime);

    if (validated.imageValid) {
      log.info('Content ready', { attempts: attempt + 1 });
      return validated;
    }

    // validateImage throws ManualReviewRequiredError once the attempt budget is
    // spent, so this loop cannot reach its bound in practice. The `for` bound is
    // a second, structural guarantee that it terminates.
    state = validated;
  }

  throw new NonRetryableError(
    `Image validation loop exceeded ${config.MAX_GENERATION_ATTEMPTS} attempts without terminating`,
    { code: 'GENERATION_LOOP_BOUND', context: { jobId: state.jobId } },
  );
};

/** Lambda entry point. `context` supplies the real remaining-time budget. */
export const handler = async (
  input: CreateJobInput,
  context?: { getRemainingTimeInMillis?: () => number },
): Promise<PrepareContentResult> => {
  const remainingTimeMs = context?.getRemainingTimeInMillis?.bind(context);
  return prepareContent(input, getRuntime(), remainingTimeMs ? { remainingTimeMs } : {});
};
