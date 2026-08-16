import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';

import { ConfigurationError } from './errors/index.js';

/**
 * The only shape a Meta secret may take. Documented in docs/meta-onboarding.md.
 * No real value ever appears in this repository.
 */
export const metaSecretSchema = z.object({
  /** Long-lived Page access token. Rotated per docs/operations.md. */
  pageAccessToken: z.string().min(20),
  /**
   * Instagram publishing uses the same Page token in the current Graph flow;
   * kept separate so a future split does not require a code change.
   */
  instagramAccessToken: z.string().min(20).optional(),
  appId: z.string().min(1).optional(),
  /** Used for appsecret_proof. Optional but strongly recommended. */
  appSecret: z.string().min(1).optional(),
});

export type MetaSecret = z.infer<typeof metaSecretSchema>;

/**
 * Shape for a single-vendor API key, currently OpenAI. Kept separate from the
 * Meta secret so the two rotate independently and a Lambda can be granted one
 * without the other.
 */
export const apiKeySecretSchema = z.object({
  apiKey: z.string().min(20),
});

export type ApiKeySecret = z.infer<typeof apiKeySecretSchema>;

export interface SecretsPort {
  getMetaSecret(secretArn: string): Promise<MetaSecret>;
  getApiKeySecret(secretArn: string): Promise<ApiKeySecret>;
}

/**
 * Secrets Manager reader with a per-container cache. Values are never logged and
 * never placed in Step Functions input/output or DynamoDB.
 */
export class SecretsManagerPort implements SecretsPort {
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  public constructor(
    private readonly client: SecretsManagerClient = new SecretsManagerClient({}),
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  /**
   * Fetches, parses and caches one secret. Parse failures name the offending
   * fields and never echo the value, so a malformed secret cannot leak through
   * an error message or a log line.
   */
  private async read<T>(
    secretArn: string,
    schema: z.ZodType<T>,
    label: string,
    guidance: string,
  ): Promise<T> {
    const cached = this.cache.get(secretArn);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;

    const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!result.SecretString) {
      throw new ConfigurationError(`${label} has no SecretString payload.`);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.SecretString);
    } catch {
      throw new ConfigurationError(`${label} is not valid JSON. See ${guidance}.`);
    }

    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ConfigurationError(
        `${label} shape is invalid: missing/invalid ${parsed.error.issues
          .map((issue) => issue.path.join('.'))
          .join(', ')}`,
      );
    }

    this.cache.set(secretArn, { value: parsed.data, expiresAt: Date.now() + this.ttlMs });
    return parsed.data;
  }

  public async getMetaSecret(secretArn: string): Promise<MetaSecret> {
    return this.read(secretArn, metaSecretSchema, 'Meta secret', 'docs/meta-onboarding.md');
  }

  public async getApiKeySecret(secretArn: string): Promise<ApiKeySecret> {
    return this.read(secretArn, apiKeySecretSchema, 'API key secret', 'docs/brand-consistency.md');
  }
}

/** Test/local double. Refuses to hand out anything that looks like a real token. */
export class StaticSecretsPort implements SecretsPort {
  public constructor(
    private readonly secret: MetaSecret,
    private readonly apiKey?: ApiKeySecret,
  ) {}

  public async getMetaSecret(): Promise<MetaSecret> {
    return this.secret;
  }

  public async getApiKeySecret(): Promise<ApiKeySecret> {
    if (!this.apiKey) {
      throw new ConfigurationError('No API key secret configured on this StaticSecretsPort.');
    }
    return this.apiKey;
  }
}

export interface KillSwitchPort {
  isEngaged(): Promise<boolean>;
}

/**
 * Kill switch backed by SSM Parameter Store. Setting the parameter to "true"
 * halts all scheduled publishing immediately without deleting any asset, and
 * without a deployment.
 */
export class SsmKillSwitch implements KillSwitchPort {
  private cached: { value: boolean; expiresAt: number } | undefined;

  public constructor(
    private readonly parameterName: string,
    private readonly client: SSMClient = new SSMClient({}),
    private readonly ttlMs = 30_000,
  ) {}

  public async isEngaged(): Promise<boolean> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    try {
      const result = await this.client.send(
        new GetParameterCommand({ Name: this.parameterName }),
      );
      const value = (result.Parameter?.Value ?? 'false').trim().toLowerCase() === 'true';
      this.cached = { value, expiresAt: Date.now() + this.ttlMs };
      return value;
    } catch {
      // Fail safe: if the switch cannot be read, assume it is engaged.
      return true;
    }
  }
}

export class StaticKillSwitch implements KillSwitchPort {
  public constructor(private readonly engaged: boolean) {}

  public async isEngaged(): Promise<boolean> {
    return this.engaged;
  }
}
