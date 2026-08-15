/**
 * Redaction for logs, Step Functions payloads and persisted records.
 *
 * Nothing in this system may write a token to CloudWatch, to Step Functions
 * input/output, or to DynamoDB. Every provider response passes through `redact`
 * before it is logged or stored.
 */

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|credential|authorization|auth|api[-_]?key|signature|session|cookie|private[-_]?key)/i;

/** Long opaque strings that look like credentials even when the key name is innocent. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /^EAA[A-Za-z0-9]{20,}$/, // Meta access tokens
  /^sk-[A-Za-z0-9_-]{20,}$/, // generic model provider keys
  /^(ASIA|AKIA)[A-Z0-9]{16}$/, // AWS access key ids
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWTs
];

/** Query parameters that must be stripped from any URL we log or persist. */
const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'client_secret',
  'appsecret_proof',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'signature',
  'sig',
]);

export const REDACTED = '[REDACTED]';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Strip credential-bearing query parameters from a URL while keeping it
 * recognisable for debugging (host + path survive).
 */
export const redactUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
      url.searchParams.set(key, REDACTED);
    }
  }
  return url.toString();
};

const redactString = (value: string): string => {
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return REDACTED;
  if (value.startsWith('http://') || value.startsWith('https://')) return redactUrl(value);
  return value;
};

/**
 * Deep-redact any structure. Cycles are handled, depth is bounded, and the input
 * is never mutated.
 */
export const redact = <T>(value: T, maxDepth = 12): T => {
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[TRUNCATED]';
    if (typeof input === 'string') return redactString(input);
    if (input === null || typeof input !== 'object') return input;

    if (seen.has(input)) return '[CIRCULAR]';
    seen.add(input);

    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));

    if (input instanceof Error) {
      return {
        name: input.name,
        message: redactString(input.message),
        ...(isPlainObject((input as unknown as { context?: unknown }).context)
          ? { context: walk((input as unknown as { context: unknown }).context, depth + 1) }
          : {}),
      };
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : walk(item, depth + 1);
    }
    return output;
  };

  return walk(value, 0) as T;
};

/**
 * Redact a raw response body we do not control the shape of, and cap its size so
 * a huge provider payload cannot blow up a log line or a DynamoDB item.
 */
export const redactPayload = (value: unknown, maxBytes = 8_000): unknown => {
  const redacted = redact(value);
  const serialised = JSON.stringify(redacted);
  if (serialised !== undefined && serialised.length > maxBytes) {
    return { truncated: true, bytes: serialised.length, preview: serialised.slice(0, maxBytes) };
  }
  return redacted;
};
