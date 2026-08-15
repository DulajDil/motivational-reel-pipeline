import {
  DynamoJobRepository,
  NonRetryableError,
  S3ObjectStore,
  SecretsManagerPort,
  SsmKillSwitch,
  StaticKillSwitch,
  createLogger,
  getConfig,
  type AppConfig,
  type JobRepository,
  type KillSwitchPort,
  type Logger,
  type ObjectStore,
  type Platform,
  type SecretsPort,
} from '@mrp/shared';
import { createProviders, createPublisher, type ProviderBundle, type SocialPublisher } from '@mrp/providers';

/**
 * Runtime context.
 *
 * Handlers never construct clients themselves; they take a `Runtime`. The AWS
 * runtime is built once per container, and tests supply an in-memory one, which
 * is what lets the whole workflow run offline.
 */
export interface Runtime {
  config: AppConfig;
  logger: Logger;
  repository: JobRepository;
  store: ObjectStore;
  providers: ProviderBundle;
  secrets: SecretsPort;
  killSwitch: KillSwitchPort;
  clock: () => Date;
  publisherFor: (platform: Platform) => Promise<SocialPublisher>;
}

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new NonRetryableError(`${name} is not set on this function`);
  return value;
};

let cached: Runtime | undefined;

export const createAwsRuntime = (): Runtime => {
  const config = getConfig();
  const logger = createLogger('handlers', config.LOG_LEVEL);

  const repository = new DynamoJobRepository({
    tableName: requireEnv('TABLE_NAME'),
    region: config.AWS_REGION,
  });
  const store = new S3ObjectStore({
    bucket: requireEnv('ASSETS_BUCKET'),
    region: config.AWS_REGION,
  });
  const secrets = new SecretsManagerPort();

  const killSwitch = config.KILL_SWITCH_PARAMETER_NAME
    ? new SsmKillSwitch(config.KILL_SWITCH_PARAMETER_NAME)
    : new StaticKillSwitch(config.KILL_SWITCH_ENABLED);

  const publishers = new Map<Platform, Promise<SocialPublisher>>();

  return {
    config,
    logger,
    repository,
    store,
    secrets,
    killSwitch,
    providers: createProviders({ config, store }),
    clock: () => new Date(),
    publisherFor: (platform) => {
      let publisher = publishers.get(platform);
      if (!publisher) {
        publisher = createPublisher({ config, platform, secrets, logger });
        publishers.set(platform, publisher);
      }
      return publisher;
    },
  };
};

export const getRuntime = (): Runtime => {
  cached ??= createAwsRuntime();
  return cached;
};

export const resetRuntimeCache = (): void => {
  cached = undefined;
};
