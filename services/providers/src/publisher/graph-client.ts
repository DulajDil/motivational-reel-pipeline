import { createHmac } from 'node:crypto';

import {
  ConfigurationError,
  ManualReviewRequiredError,
  NonRetryableError,
  RetryableError,
  redactPayload,
  withRetry,
  type Logger,
} from '@mrp/shared';

import type { GraphRequest } from './payloads.js';

/**
 * Meta Graph transport.
 *
 * Responsibilities kept here and nowhere else:
 *   - attach the access token as an Authorization header (never a query param),
 *   - attach appsecret_proof when an app secret is configured,
 *   - classify Graph errors into the shared error taxonomy,
 *   - redact every response before it is logged or returned for persistence.
 */

export interface GraphErrorPayload {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

/** Transient/throttling codes. Safe to retry the same request. */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

/** Token, permission and app-review problems. A human must fix configuration. */
const CONFIGURATION_CODES = new Set([102, 190, 200, 10, 803]);

export class GraphApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly payload: GraphErrorPayload,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

export const classifyGraphError = (status: number, payload: GraphErrorPayload): Error => {
  const code = payload.code ?? 0;
  const detail = `${payload.type ?? 'GraphError'} code=${code} subcode=${payload.error_subcode ?? '-'} trace=${payload.fbtrace_id ?? '-'}`;
  const message = payload.message ?? `Graph API returned HTTP ${status}`;

  if (CONFIGURATION_CODES.has(code)) {
    return new ConfigurationError(
      `Meta rejected the credentials or permissions: ${message}. Check token validity, scopes and app review status (${detail}).`,
      { code: `META_${code}` },
    );
  }
  if (status === 429 || RETRYABLE_CODES.has(code)) {
    return new RetryableError(`Meta rate limited or transient failure: ${message} (${detail})`, {
      code: `META_${code || status}`,
      retryAfterSeconds: 60,
    });
  }
  if (status >= 500) {
    return new RetryableError(`Meta server error: ${message} (${detail})`, {
      code: `META_HTTP_${status}`,
    });
  }
  if (status === 400) {
    return new NonRetryableError(`Meta rejected the request: ${message} (${detail})`, {
      code: `META_${code || 400}`,
    });
  }
  return new ManualReviewRequiredError(
    `Unclassified Meta response: ${message} (${detail})`,
    'unclassified_meta_error',
    { code: `META_HTTP_${status}` },
  );
};

export interface GraphClientOptions {
  accessToken: string;
  /** Enables appsecret_proof, which Meta recommends for server-side calls. */
  appSecret?: string | undefined;
  logger?: Logger | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface GraphResponse<T = unknown> {
  status: number;
  /** Already redacted. Safe to persist and log. */
  body: T;
}

export class GraphClient {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: GraphClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private appSecretProof(): string | undefined {
    if (!this.options.appSecret) return undefined;
    return createHmac('sha256', this.options.appSecret)
      .update(this.options.accessToken)
      .digest('hex');
  }

  public async send<T = unknown>(request: GraphRequest): Promise<GraphResponse<T>> {
    const proof = this.appSecretProof();

    const execute = async (): Promise<GraphResponse<T>> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);

      try {
        const headers: Record<string, string> = {
          // Token travels in the header so it never lands in a URL or an access log.
          Authorization: `Bearer ${this.options.accessToken}`,
          Accept: 'application/json',
          ...(request.headers ?? {}),
        };

        let body: string | undefined;
        if (request.form) {
          const form = new URLSearchParams(request.form);
          if (proof) form.set('appsecret_proof', proof);
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          body = form.toString();
        }

        const url = new URL(request.url);
        if (proof && !request.form) url.searchParams.set('appsecret_proof', proof);

        const response = await this.fetchImpl(url.toString(), {
          method: request.method,
          headers,
          body,
          signal: controller.signal,
        });

        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { raw: text.slice(0, 500) };
        }

        if (!response.ok) {
          const payload = (parsed as { error?: GraphErrorPayload }).error ?? {};
          this.options.logger?.warn('Meta Graph call failed', {
            status: response.status,
            url: request.url,
            error: redactPayload(payload),
          });
          throw classifyGraphError(response.status, payload);
        }

        return { status: response.status, body: redactPayload(parsed) as T };
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          throw new RetryableError('Meta Graph call timed out', { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };

    // Tight in-process retry for transport blips only. Task-level retries stay
    // with Step Functions so attempts remain visible and bounded.
    return withRetry(execute, {
      maxAttempts: this.options.maxAttempts ?? 3,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
      onRetry: (error, attempt, delayMs) =>
        this.options.logger?.warn('Retrying Meta Graph call', {
          attempt,
          delayMs,
          error: redactPayload(error),
        }),
    });
  }
}
