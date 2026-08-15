/**
 * Structured error taxonomy.
 *
 * Retry ownership is explicit and split between two layers:
 *   - `RetryableError`      Step Functions owns the retry (backoff + jitter in the
 *                           state machine). Handlers must NOT retry these in-process.
 *   - `NonRetryableError`   terminal. Step Functions catches and fails the branch.
 *   - `ManualReviewRequiredError` terminal for automation, routed to the review queue.
 *   - `ConfigurationError`  terminal and alarming. Never retried, never queued.
 *
 * The `name` of each class is what Step Functions matches on in Retry/Catch blocks,
 * so these strings are part of the infrastructure contract. See infra/lib/workflow-stack.ts.
 */

export type ErrorKind = 'retryable' | 'non_retryable' | 'manual_review' | 'configuration';

export interface AppErrorOptions {
  /** Machine readable sub-code, e.g. `META_RATE_LIMITED`. */
  code?: string;
  /** Underlying cause. Redacted before logging. */
  cause?: unknown;
  /** Structured, already-safe context. Never put tokens in here. */
  context?: Record<string, unknown>;
  /** Hint for the state machine, in seconds. */
  retryAfterSeconds?: number;
}

export abstract class AppError extends Error {
  public abstract readonly kind: ErrorKind;

  public readonly code: string;

  public readonly context: Record<string, unknown>;

  public readonly retryAfterSeconds: number | undefined;

  protected constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? new.target.name;
    this.context = options.context ?? {};
    this.retryAfterSeconds = options.retryAfterSeconds;
    Error.captureStackTrace?.(this, new.target);
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      code: this.code,
      message: this.message,
      context: this.context,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

/** Transient failure. Safe to retry the whole task. */
export class RetryableError extends AppError {
  public readonly kind = 'retryable' as const;

  public constructor(message: string, options?: AppErrorOptions) {
    super(message, options);
  }
}

/** Permanent failure for this input. Retrying will not help. */
export class NonRetryableError extends AppError {
  public readonly kind = 'non_retryable' as const;

  public constructor(message: string, options?: AppErrorOptions) {
    super(message, options);
  }
}

/** Automation has exhausted its options; a human must look at it. */
export class ManualReviewRequiredError extends AppError {
  public readonly kind = 'manual_review' as const;

  public readonly reviewReason: string;

  public constructor(message: string, reviewReason: string, options?: AppErrorOptions) {
    super(message, options);
    this.reviewReason = reviewReason;
  }

  public override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), reviewReason: this.reviewReason };
  }
}

/** The deployment/config is wrong. Alarm, do not retry, do not queue for review. */
export class ConfigurationError extends AppError {
  public readonly kind = 'configuration' as const;

  public constructor(message: string, options?: AppErrorOptions) {
    super(message, options);
  }
}

/** A guard (kill switch, daily cap, cost budget) stopped the work on purpose. */
export class GuardTrippedError extends NonRetryableError {
  public readonly guard: string;

  public constructor(guard: string, message: string, options?: AppErrorOptions) {
    super(message, { ...options, code: options?.code ?? 'GUARD_TRIPPED' });
    this.name = 'GuardTrippedError';
    this.guard = guard;
  }
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

export const errorKindOf = (value: unknown): ErrorKind =>
  isAppError(value) ? value.kind : 'retryable';

/**
 * Classify an arbitrary thrown value. Unknown errors default to retryable so a
 * transient blip does not permanently kill a job, but the state machine bounds
 * the attempts so this cannot loop forever.
 */
export const toAppError = (value: unknown, fallbackMessage = 'Unhandled error'): AppError => {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new RetryableError(value.message || fallbackMessage, { cause: value });
  }
  return new RetryableError(fallbackMessage, { context: { raw: String(value) } });
};

/** Every error name the state machine is allowed to match on. */
export const ERROR_NAMES = {
  retryable: 'RetryableError',
  nonRetryable: 'NonRetryableError',
  manualReview: 'ManualReviewRequiredError',
  configuration: 'ConfigurationError',
  guard: 'GuardTrippedError',
} as const;
