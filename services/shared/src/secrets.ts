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

export interface SecretsPort {
  getMetaSecret(secretArn: string): Promise<MetaSecret>;
}

/**
 * Secrets Manager reader with a per-container cache. Values are never logged and
 * never placed in Step Functions input/output or DynamoDB.
 */
export class SecretsManagerPort implements SecretsPort {
  private readonly cache = new Map<string, { value: MetaSecret; expiresAt: number }>();

  public constructor(
    private readonly client: SecretsManagerClient = new SecretsManagerClient({}),
    private readonly ttlMs = 5 * 60 * 1000,
  ) {}

  public async getMetaSecret(secretArn: string): Promise<MetaSecret> {
    const cached = this.cache.get(secretArn);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!result.SecretString) {
      throw new ConfigurationError('Meta secret has no SecretString payload.');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.SecretString);
    } catch {
      throw new ConfigurationError('Meta secret is not valid JSON. See docs/meta-onboarding.md.');
    }

    const parsed = metaSecretSchema.safeParse(parsedJson);
    if (!parsed.success) {
      // Deliberately does not echo the value, only the failing field names.
      throw new ConfigurationError(
        `Meta secret shape is invalid: missing/invalid ${parsed.error.issues
          .map((issue) => issue.path.join('.'))
          .join(', ')}`,
      );
    }

    this.cache.set(secretArn, { value: parsed.data, expiresAt: Date.now() + this.ttlMs });
    return parsed.data;
  }
}

/** Test/local double. Refuses to hand out anything that looks like a real token. */
export class StaticSecretsPort implements SecretsPort {
  public constructor(private readonly secret: MetaSecret) {}

  public async getMetaSecret(): Promise<MetaSecret> {
    return this.secret;
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
