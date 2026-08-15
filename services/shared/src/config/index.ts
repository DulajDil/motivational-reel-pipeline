import { ConfigurationError } from '../errors/index.js';
import { parsePublishWindows, type TimeWindow } from '../util/time.js';
import {
  rawConfigSchema,
  type MusicMode,
  type Platform,
  type ProviderMode,
  type PublishMode,
  type QuoteRenderMode,
  type RawConfig,
} from './schema.js';

export * from './schema.js';

export interface AppConfig extends RawConfig {
  /** Parsed form of PUBLISH_WINDOWS. */
  publishWindows: TimeWindow[];
  /**
   * True only when every independent guard agrees. This is the single value the
   * publishers check; there is no other route to a real Meta call.
   */
  productionPublishingEnabled: boolean;
  /** Region used for Bedrock text calls (may differ from the stack region). */
  bedrockRegion: string;
  /** Region used for Bedrock image calls; often not the stack region at all. */
  bedrockImageRegion: string;
}

const requireValue = (value: string | undefined, name: string, why: string): string => {
  if (!value) throw new ConfigurationError(`${name} is required ${why}.`);
  return value;
};

/**
 * Cross-field validation. Anything that could cause an unlicensed, mis-targeted
 * or unintended publish is refused here rather than at the call site.
 */
const validate = (config: RawConfig): void => {
  if (config.QUOTE_MIN_WORDS > config.QUOTE_MAX_WORDS) {
    throw new ConfigurationError('QUOTE_MIN_WORDS must be <= QUOTE_MAX_WORDS.');
  }

  // Music: "royalty free" is not a licence. A licence reference is mandatory.
  if (config.MUSIC_MODE === 'owned_licensed') {
    const uri = requireValue(config.MUSIC_S3_URI, 'MUSIC_S3_URI', 'when MUSIC_MODE=owned_licensed');
    if (!uri.startsWith('s3://')) {
      throw new ConfigurationError('MUSIC_S3_URI must be an s3:// URI. Music stays in private S3.');
    }
    requireValue(
      config.MUSIC_LICENSE_REFERENCE,
      'MUSIC_LICENSE_REFERENCE',
      'when MUSIC_MODE=owned_licensed - see docs/music-rights.md for accepted evidence',
    );
  }

  if (config.REFERENCE_IMAGE_S3_URI && !config.REFERENCE_IMAGE_S3_URI.startsWith('s3://')) {
    throw new ConfigurationError(
      'REFERENCE_IMAGE_S3_URI must be an s3:// URI in the private assets bucket.',
    );
  }

  if (config.QUOTE_RENDER_MODE === 'embedded_ai' && config.ENVIRONMENT === 'prod') {
    throw new ConfigurationError(
      'QUOTE_RENDER_MODE=embedded_ai is not permitted in prod: generated typography is not reliable. Use overlay or hybrid.',
    );
  }

  if (config.PROVIDER_MODE === 'bedrock') {
    requireValue(config.BEDROCK_TEXT_MODEL_ID, 'BEDROCK_TEXT_MODEL_ID', 'when PROVIDER_MODE=bedrock');
    requireValue(
      config.BEDROCK_IMAGE_MODEL_ID,
      'BEDROCK_IMAGE_MODEL_ID',
      'when PROVIDER_MODE=bedrock - verify the model is enabled in this region/account',
    );
  }

  // Meta identifiers are only mandatory once we might actually call Meta.
  if (config.PUBLISH_MODE !== 'dry_run' && config.ALLOW_PRODUCTION_PUBLISH) {
    requireValue(config.META_SECRET_ARN, 'META_SECRET_ARN', 'when production publishing is enabled');
    if (config.ENABLED_PLATFORMS.includes('instagram')) {
      requireValue(
        config.INSTAGRAM_ACCOUNT_ID,
        'INSTAGRAM_ACCOUNT_ID',
        'when Instagram publishing is enabled',
      );
    }
    if (config.ENABLED_PLATFORMS.includes('facebook')) {
      requireValue(
        config.FACEBOOK_PAGE_ID,
        'FACEBOOK_PAGE_ID',
        'when Facebook publishing is enabled',
      );
    }
  }
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = rawConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid configuration: ${issues}`);
  }

  const config = parsed.data;
  validate(config);

  const productionPublishingEnabled =
    config.ALLOW_PRODUCTION_PUBLISH &&
    config.ENVIRONMENT === 'prod' &&
    config.PUBLISH_MODE !== 'dry_run' &&
    !config.KILL_SWITCH_ENABLED;

  return {
    ...config,
    publishWindows: parsePublishWindows(config.PUBLISH_WINDOWS),
    productionPublishingEnabled,
    bedrockRegion: config.BEDROCK_REGION ?? config.AWS_REGION,
    bedrockImageRegion:
      config.BEDROCK_IMAGE_REGION ?? config.BEDROCK_REGION ?? config.AWS_REGION,
  };
};

let cached: AppConfig | undefined;

/** Cached per Lambda container. Call `resetConfigCache()` in tests. */
export const getConfig = (): AppConfig => {
  cached ??= loadConfig();
  return cached;
};

export const resetConfigCache = (): void => {
  cached = undefined;
};

export type {
  MusicMode,
  Platform,
  ProviderMode,
  PublishMode,
  QuoteRenderMode,
  RawConfig,
  TimeWindow,
};
