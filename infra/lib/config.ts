import type { Construct } from 'constructs';

/**
 * Deploy-time settings.
 *
 * Read from CDK context (`-c key=value`) or the environment. Nothing secret ever
 * appears here: only identifiers, sizes and feature flags. Secrets live in
 * Secrets Manager and are referenced by ARN.
 */
export interface DeploySettings {
  environment: 'dev' | 'staging' | 'prod';
  region: string;
  account?: string | undefined;
  /** Tag of the pre-built renderer image in ECR. */
  rendererImageTag: string;
  /** Days finished MP4s are kept before archival/deletion. */
  retainFinalsDays: number;
  /** Days audit manifests and receipts are kept. Deliberately much longer. */
  retainAuditDays: number;
  alarmEmail?: string | undefined;
  /** Non-secret runtime configuration handed to every function. */
  runtimeEnv: Record<string, string>;
}

const ctx = (scope: Construct, key: string): string | undefined => {
  const value = scope.node.tryGetContext(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const loadDeploySettings = (scope: Construct): DeploySettings => {
  const environment = (ctx(scope, 'environment') ?? process.env.ENVIRONMENT ?? 'dev') as
    | 'dev'
    | 'staging'
    | 'prod';
  const region = ctx(scope, 'region') ?? process.env.AWS_REGION ?? 'ap-southeast-2';

  return {
    environment,
    region,
    account: process.env.CDK_DEFAULT_ACCOUNT,
    rendererImageTag: ctx(scope, 'rendererImageTag') ?? process.env.RENDERER_IMAGE_TAG ?? 'latest',
    retainFinalsDays: Number(ctx(scope, 'retainFinalsDays') ?? 180),
    retainAuditDays: Number(ctx(scope, 'retainAuditDays') ?? 1_095),
    alarmEmail: ctx(scope, 'alarmEmail') ?? process.env.ALARM_EMAIL,
    runtimeEnv: {
      ENVIRONMENT: environment,
      AWS_REGION_NAME: region,
      LOG_LEVEL: ctx(scope, 'logLevel') ?? 'INFO',
      PROVIDER_MODE: ctx(scope, 'providerMode') ?? 'mock',
      PUBLISH_MODE: ctx(scope, 'publishMode') ?? 'dry_run',
      // Safe by default: a deploy alone can never enable live publishing.
      ALLOW_PRODUCTION_PUBLISH: ctx(scope, 'allowProductionPublish') ?? 'false',
      QUOTE_RENDER_MODE: ctx(scope, 'quoteRenderMode') ?? 'overlay',
      MUSIC_MODE: ctx(scope, 'musicMode') ?? 'silent',
      DAILY_TARGET: ctx(scope, 'dailyTarget') ?? '5',
      MAX_DAILY_PUBLISHES_PER_PLATFORM: ctx(scope, 'maxDailyPublishes') ?? '5',
      SCHEDULE_TIMEZONE: ctx(scope, 'scheduleTimezone') ?? 'Pacific/Auckland',
      PUBLISH_WINDOWS: ctx(scope, 'publishWindows') ?? '07:00-09:30,12:00-13:30,18:00-21:00',
      META_GRAPH_API_VERSION: ctx(scope, 'metaGraphApiVersion') ?? 'v21.0',
      INSTAGRAM_ACCOUNT_ID: ctx(scope, 'instagramAccountId') ?? '',
      FACEBOOK_PAGE_ID: ctx(scope, 'facebookPageId') ?? '',
      BEDROCK_TEXT_MODEL_ID: ctx(scope, 'bedrockTextModelId') ?? '',
      BEDROCK_IMAGE_MODEL_ID: ctx(scope, 'bedrockImageModelId') ?? '',
      BEDROCK_IMAGE_REGION: ctx(scope, 'bedrockImageRegion') ?? '',
      BEDROCK_IMAGE_BODY_STYLE: ctx(scope, 'bedrockImageBodyStyle') ?? 'nova_titan',
      REFERENCE_IMAGE_S3_URI: ctx(scope, 'referenceImageS3Uri') ?? '',
      REFERENCE_SIMILARITY_STRENGTH: ctx(scope, 'referenceSimilarityStrength') ?? '0.5',
      BRAND_HANDLE: ctx(scope, 'brandHandle') ?? '',
      COST_GUARD_ENABLED: ctx(scope, 'costGuardEnabled') ?? 'true',
      CONFIG_VERSION: ctx(scope, 'configVersion') ?? '1',
    },
  };
};

export const resourceName = (settings: DeploySettings, suffix: string): string =>
  `mrp-${settings.environment}-${suffix}`;
