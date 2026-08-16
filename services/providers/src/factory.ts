import {
  ConfigurationError,
  type AppConfig,
  type Logger,
  type ObjectStore,
  type Platform,
  type SecretsPort,
} from '@mrp/shared';

import { BedrockClient } from './bedrock-client.js';
import { BedrockCaptionGenerator } from './caption/bedrock.js';
import { MockCaptionGenerator } from './caption/mock.js';
import { BedrockImageGenerator, type BedrockImageBodyStyle } from './image/bedrock.js';
import { MockImageGenerator } from './image/mock.js';
import { ConfiguredMusicProvider } from './music/index.js';
import { DryRunPublisher } from './publisher/dry-run.js';
import { FacebookPublisher } from './publisher/facebook.js';
import { GraphClient } from './publisher/graph-client.js';
import { InstagramPublisher } from './publisher/instagram.js';
import type { GraphEndpointConfig } from './publisher/payloads.js';
import { BedrockQuoteGenerator } from './quote/bedrock.js';
import { MockQuoteGenerator } from './quote/mock.js';
import { LocalImageValidator } from './validator/local.js';
import { RekognitionImageValidator } from './validator/rekognition.js';
import type {
  CaptionGenerator,
  ImageGenerator,
  ImageValidator,
  MusicProvider,
  QuoteGenerator,
  SocialPublisher,
} from './types.js';

/**
 * Provider binding.
 *
 * `PROVIDER_MODE=mock` gives a fully offline pipeline; `bedrock` binds the real
 * generators. Publishers are handled separately and far more conservatively -
 * see `createPublisher`.
 */

export interface ProviderBundle {
  quote: QuoteGenerator;
  caption: CaptionGenerator;
  image: ImageGenerator;
  validator: ImageValidator;
  music: MusicProvider;
}

export interface CreateProvidersOptions {
  config: AppConfig;
  /** Private assets bucket, needed to fetch licensed music. */
  store?: ObjectStore | undefined;
  /** Test override; production reads BEDROCK_IMAGE_BODY_STYLE from config. */
  bedrockImageBodyStyle?: BedrockImageBodyStyle;
}

export const createProviders = ({
  config,
  store,
  bedrockImageBodyStyle,
}: CreateProvidersOptions): ProviderBundle => {
  const music = new ConfiguredMusicProvider({
    mode: config.MUSIC_MODE,
    s3Uri: config.MUSIC_S3_URI,
    licenseReference: config.MUSIC_LICENSE_REFERENCE,
    volumeDb: config.MUSIC_VOLUME_DB,
    store,
  });

  if (config.PROVIDER_MODE === 'mock') {
    return {
      quote: new MockQuoteGenerator(),
      caption: new MockCaptionGenerator(),
      image: new MockImageGenerator(),
      validator: new LocalImageValidator(),
      music,
    };
  }

  // Validated in loadConfig, re-asserted here so this factory is safe standalone.
  const textModelId = config.BEDROCK_TEXT_MODEL_ID;
  const imageModelId = config.BEDROCK_IMAGE_MODEL_ID;
  if (!textModelId || !imageModelId) {
    throw new ConfigurationError(
      'PROVIDER_MODE=bedrock requires BEDROCK_TEXT_MODEL_ID and BEDROCK_IMAGE_MODEL_ID.',
    );
  }

  const textClient = BedrockClient.forRegion(config.bedrockRegion);
  // Image generation frequently has to run somewhere else: several regions
  // carry text models but no image-generation models at all.
  const imageClient =
    config.bedrockImageRegion === config.bedrockRegion
      ? textClient
      : BedrockClient.forRegion(config.bedrockImageRegion);

  return {
    quote: new BedrockQuoteGenerator({ client: textClient, modelId: textModelId }),
    caption: new BedrockCaptionGenerator({ client: textClient, modelId: textModelId }),
    image: new BedrockImageGenerator({
      client: imageClient,
      modelId: imageModelId,
      bodyStyle: bedrockImageBodyStyle ?? config.BEDROCK_IMAGE_BODY_STYLE,
    }),
    validator: new RekognitionImageValidator({ region: config.AWS_REGION }),
    music,
  };
};

export interface CreatePublisherOptions {
  config: AppConfig;
  platform: Platform;
  secrets: SecretsPort;
  logger?: Logger | undefined;
  fetchImpl?: typeof fetch;
}

/**
 * Publisher binding, with the production guard.
 *
 * A live publisher is returned ONLY when `config.productionPublishingEnabled` is
 * true, which itself requires ALL of: ALLOW_PRODUCTION_PUBLISH=true,
 * ENVIRONMENT=prod, PUBLISH_MODE != dry_run and the kill switch disengaged.
 * Every other path returns `DryRunPublisher`, which builds the real payloads but
 * makes no network call.
 */
export const createPublisher = async ({
  config,
  platform,
  secrets,
  logger,
  fetchImpl,
}: CreatePublisherOptions): Promise<SocialPublisher> => {
  const endpoint: GraphEndpointConfig = {
    baseUrl: config.META_GRAPH_BASE_URL,
    version: config.META_GRAPH_API_VERSION,
  };

  const accountId =
    platform === 'instagram' ? config.INSTAGRAM_ACCOUNT_ID : config.FACEBOOK_PAGE_ID;

  if (!config.productionPublishingEnabled) {
    logger?.info('Publisher bound in dry-run mode; no Meta call will be made', {
      platform,
      environment: config.ENVIRONMENT,
      publishMode: config.PUBLISH_MODE,
      allowProductionPublish: config.ALLOW_PRODUCTION_PUBLISH,
      killSwitchEnabled: config.KILL_SWITCH_ENABLED,
    });
    return new DryRunPublisher(platform, {
      endpoint,
      accountId: accountId ?? `placeholder-${platform}-id`,
      shareToFeed: config.INSTAGRAM_SHARE_TO_FEED,
    });
  }

  if (!config.META_SECRET_ARN) {
    throw new ConfigurationError('META_SECRET_ARN is required for live publishing.');
  }
  if (!accountId) {
    throw new ConfigurationError(
      `${platform === 'instagram' ? 'INSTAGRAM_ACCOUNT_ID' : 'FACEBOOK_PAGE_ID'} is required for live publishing.`,
    );
  }

  const secret = await secrets.getMetaSecret(config.META_SECRET_ARN);
  const accessToken =
    platform === 'instagram'
      ? (secret.instagramAccessToken ?? secret.pageAccessToken)
      : secret.pageAccessToken;

  const client = new GraphClient({
    accessToken,
    appSecret: secret.appSecret,
    logger,
    fetchImpl,
  });

  return platform === 'instagram'
    ? new InstagramPublisher({
        client,
        endpoint,
        igUserId: accountId,
        shareToFeed: config.INSTAGRAM_SHARE_TO_FEED,
      })
    : new FacebookPublisher({ client, endpoint, pageId: accountId });
};
