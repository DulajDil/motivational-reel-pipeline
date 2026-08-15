import { z } from 'zod';

/**
 * Typed configuration.
 *
 * Rules encoded here:
 *  - Safe by default. Nothing publishes unless several independent flags agree.
 *  - No model id is hardcoded; Bedrock ids are required only when PROVIDER_MODE=bedrock.
 *  - Music is silent unless an owned/licensed track AND a licence reference exist.
 *  - Meta identifiers are required only when publishing is actually enabled.
 */

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['true', '1', 'yes', 'on'].includes(value.toLowerCase()),
  );

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

export const ENVIRONMENTS = ['dev', 'staging', 'prod', 'test'] as const;
export const PUBLISH_MODES = ['dry_run', 'manual_approval', 'auto_publish'] as const;
export const QUOTE_RENDER_MODES = ['overlay', 'embedded_ai', 'hybrid'] as const;
export const MUSIC_MODES = ['owned_licensed', 'silent'] as const;
export const PROVIDER_MODES = ['mock', 'bedrock'] as const;
export const PLATFORMS = ['instagram', 'facebook'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];
export type PublishMode = (typeof PUBLISH_MODES)[number];
export type QuoteRenderMode = (typeof QUOTE_RENDER_MODES)[number];
export type MusicMode = (typeof MUSIC_MODES)[number];
export type ProviderMode = (typeof PROVIDER_MODES)[number];
export type Platform = (typeof PLATFORMS)[number];

export const rawConfigSchema = z.object({
  AWS_REGION: z.string().min(1).default('ap-southeast-2'),
  ENVIRONMENT: z.enum(ENVIRONMENTS).default('dev'),
  LOG_LEVEL: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).default('INFO'),
  PROVIDER_MODE: z.enum(PROVIDER_MODES).default('mock'),

  DAILY_TARGET: z.coerce.number().int().min(1).max(60).default(5),
  MAX_DAILY_PUBLISHES_PER_PLATFORM: z.coerce.number().int().min(0).max(60).default(5),

  PUBLISH_MODE: z.enum(PUBLISH_MODES).default('dry_run'),
  ENABLED_PLATFORMS: z
    .string()
    .default('instagram,facebook')
    .transform(csv)
    .pipe(z.array(z.enum(PLATFORMS)).min(1)),
  ALLOW_PRODUCTION_PUBLISH: boolish.default(false),
  KILL_SWITCH_ENABLED: boolish.default(false),

  QUOTE_RENDER_MODE: z.enum(QUOTE_RENDER_MODES).default('overlay'),
  REEL_DURATION_SECONDS: z.coerce.number().min(10).max(18).default(14),
  BRAND_HANDLE: optionalString,
  QUOTE_MIN_WORDS: z.coerce.number().int().min(3).default(6),
  QUOTE_MAX_WORDS: z.coerce.number().int().max(40).default(18),
  QUOTE_DEDUPE_WINDOW_DAYS: z.coerce.number().int().min(1).default(90),

  BEDROCK_TEXT_MODEL_ID: optionalString,
  BEDROCK_IMAGE_MODEL_ID: optionalString,
  BEDROCK_REGION: optionalString,
  /**
   * Image generation often has to run in a different region from text.
   * Verified 2026-08-15: ap-southeast-2 exposes 61 text models and ZERO
   * image-generation models, while us-east-1 exposes 14. Falls back to
   * BEDROCK_REGION, then AWS_REGION.
   */
  BEDROCK_IMAGE_REGION: optionalString,

  META_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'META_GRAPH_API_VERSION must look like v21.0')
    .default('v21.0'),
  META_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  INSTAGRAM_ACCOUNT_ID: optionalString,
  FACEBOOK_PAGE_ID: optionalString,
  META_SECRET_ARN: optionalString,
  INSTAGRAM_SHARE_TO_FEED: boolish.default(true),

  MUSIC_MODE: z.enum(MUSIC_MODES).default('silent'),
  MUSIC_S3_URI: optionalString,
  MUSIC_LICENSE_REFERENCE: optionalString,
  MUSIC_VOLUME_DB: z.coerce.number().max(0).default(-18),

  SCHEDULE_TIMEZONE: z.string().min(1).default('Pacific/Auckland'),
  PUBLISH_WINDOWS: z.string().min(1).default('07:00-09:30,12:00-13:30,18:00-21:00'),

  MAX_GENERATION_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  MAX_PUBLISH_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),
  MAX_CONTAINER_POLL_ATTEMPTS: z.coerce.number().int().min(1).max(120).default(20),
  CONTAINER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
  PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(300).max(43_200).default(3_600),
  IMAGE_GENERATION_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  PUBLISH_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),

  COST_GUARD_ENABLED: boolish.default(true),
  DAILY_COST_BUDGET_USD: z.coerce.number().min(0).default(5),
  MONTHLY_COST_BUDGET_USD: z.coerce.number().min(0).default(100),

  ASSETS_BUCKET: optionalString,
  TABLE_NAME: optionalString,
  QUOTE_FONT_PATH: optionalString,
  KILL_SWITCH_PARAMETER_NAME: optionalString,

  /** Bumped by hand when a config change should legitimately produce new content. */
  CONFIG_VERSION: z.string().default('1'),
});

export type RawConfig = z.infer<typeof rawConfigSchema>;
