import { RetryableError, isAppError } from '../errors/index.js';

export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Full jitter by default: delay = random(0, min(cap, base * 2^attempt)). */
  jitter?: 'full' | 'none';
}

/**
 * Exponential backoff with full jitter (AWS Architecture Blog, "Exponential
 * Backoff And Jitter"). Full jitter is used because several Lambdas may retry
 * the same downstream at once and we want their retries decorrelated.
 */
export const backoffDelayMs = (
  attempt: number,
  { baseDelayMs, maxDelayMs, jitter = 'full' }: BackoffOptions,
  random: () => number = Math.random,
): number => {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
  return jitter === 'none' ? exponential : Math.floor(random() * exponential);
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface RetryOptions extends BackoffOptions {
  /** Total attempts, including the first. Must be >= 1. */
  maxAttempts: number;
  /** Defaults to "retry only RetryableError and non-AppError throws". */
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleepFn?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultShouldRetry = (error: unknown): boolean =>
  !isAppError(error) || error.kind === 'retryable';

/**
 * In-process retry, used ONLY for tight external calls inside a single task
 * (e.g. one Graph API GET). Task-level retries are owned by Step Functions so
 * that attempts stay observable and bounded; do not nest the two.
 */
export const withRetry = async <T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  const {
    maxAttempts,
    shouldRetry = defaultShouldRetry,
    onRetry,
    sleepFn = sleep,
    random = Math.random,
  } = options;

  if (maxAttempts < 1) throw new RangeError('maxAttempts must be >= 1');

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !shouldRetry(error)) throw error;
      const delayMs = backoffDelayMs(attempt, options, random);
      onRetry?.(error, attempt, delayMs);
      await sleepFn(delayMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new RetryableError('Retry loop exhausted', { context: { maxAttempts } });
};
