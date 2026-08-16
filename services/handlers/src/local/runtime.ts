import {
  FileSystemObjectStore,
  InMemoryJobRepository,
  StaticKillSwitch,
  StaticSecretsPort,
  createLogger,
  loadConfig,
  type AppConfig,
  type Platform,
} from '@mrp/shared';
import { DryRunPublisher, createProviders, type SocialPublisher } from '@mrp/providers';

import type { Runtime } from '../context.js';

/**
 * Local runtime: in-memory table, filesystem object store, mock providers and a
 * publisher that builds real payloads but never calls Meta.
 *
 * No AWS credentials, no network, no LocalStack required. This is the runtime
 * used by `npm run dry-run`, `npm run render:local` and the integration tests.
 */

export interface LocalRuntimeOptions {
  /** Directory used as the object store root. */
  root: string;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  configOverrides?: Partial<AppConfig>;
  publisherOverrides?: Partial<Record<Platform, SocialPublisher>>;
}

export const createLocalRuntime = (options: LocalRuntimeOptions): Runtime => {
  const baseConfig = loadConfig({
    ENVIRONMENT: 'dev',
    PROVIDER_MODE: 'mock',
    PUBLISH_MODE: 'dry_run',
    MUSIC_MODE: 'silent',
    ALLOW_PRODUCTION_PUBLISH: 'false',
    ...options.env,
  });
  const config: AppConfig = { ...baseConfig, ...options.configOverrides };

  const store = new FileSystemObjectStore(options.root, 'local-assets');
  const clock = options.clock ?? (() => new Date());

  const publishers = new Map<Platform, SocialPublisher>();
  for (const platform of config.ENABLED_PLATFORMS) {
    publishers.set(
      platform,
      options.publisherOverrides?.[platform] ??
        new DryRunPublisher(platform, {
          endpoint: {
            baseUrl: config.META_GRAPH_BASE_URL,
            version: config.META_GRAPH_API_VERSION,
          },
          accountId:
            (platform === 'instagram' ? config.INSTAGRAM_ACCOUNT_ID : config.FACEBOOK_PAGE_ID) ??
            `placeholder-${platform}-id`,
          shareToFeed: config.INSTAGRAM_SHARE_TO_FEED,
        }),
    );
  }

  /*
   * A local run must never reach a real Meta credential, so the Meta token is
   * always a placeholder and publishing is always a dry run.
   *
   * The OpenAI key is different: generating an illustration posts nothing, and
   * tuning the house style means generating locally and looking at the result.
   * It is read from the environment when present - never from a committed file -
   * and its absence simply means IMAGE_PROVIDER=openai cannot run here.
   */
  const secrets = new StaticSecretsPort(
    { pageAccessToken: 'local-placeholder-token-not-real' },
    process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : undefined,
  );

  return {
    config,
    logger: createLogger('local', config.LOG_LEVEL),
    repository: new InMemoryJobRepository(clock),
    store,
    providers: createProviders({ config, store, secrets }),
    secrets,
    killSwitch: new StaticKillSwitch(false),
    clock,
    publisherFor: async (platform) => {
      const publisher = publishers.get(platform);
      if (!publisher) throw new Error(`No local publisher configured for ${platform}`);
      return publisher;
    },
  };
};
