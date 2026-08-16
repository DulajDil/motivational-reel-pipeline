import { describe, expect, it } from 'vitest';

import { ConfigurationError, loadConfig } from '@mrp/shared';

const base = { AWS_REGION: 'ap-southeast-2', ENVIRONMENT: 'dev' } as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('is safe by default', () => {
    const config = loadConfig(base);
    expect(config.PUBLISH_MODE).toBe('dry_run');
    expect(config.MUSIC_MODE).toBe('silent');
    expect(config.PROVIDER_MODE).toBe('mock');
    expect(config.QUOTE_RENDER_MODE).toBe('overlay');
    expect(config.ALLOW_PRODUCTION_PUBLISH).toBe(false);
    expect(config.productionPublishingEnabled).toBe(false);
  });

  it('only enables production publishing when every guard agrees', () => {
    const nearly = {
      ...base,
      ENVIRONMENT: 'prod',
      PUBLISH_MODE: 'auto_publish',
      ALLOW_PRODUCTION_PUBLISH: 'true',
      META_SECRET_ARN: 'arn:aws:secretsmanager:ap-southeast-2:1:secret:x',
      INSTAGRAM_ACCOUNT_ID: '1',
      FACEBOOK_PAGE_ID: '2',
    } as NodeJS.ProcessEnv;

    expect(loadConfig(nearly).productionPublishingEnabled).toBe(true);

    // Any single guard flipping is enough to disable it.
    expect(
      loadConfig({ ...nearly, ALLOW_PRODUCTION_PUBLISH: 'false' }).productionPublishingEnabled,
    ).toBe(false);
    expect(loadConfig({ ...nearly, PUBLISH_MODE: 'dry_run' }).productionPublishingEnabled).toBe(
      false,
    );
    expect(
      loadConfig({ ...nearly, KILL_SWITCH_ENABLED: 'true' }).productionPublishingEnabled,
    ).toBe(false);
    expect(loadConfig({ ...nearly, ENVIRONMENT: 'staging' }).productionPublishingEnabled).toBe(
      false,
    );
  });

  it('refuses licensed music without a licence reference', () => {
    expect(() =>
      loadConfig({ ...base, MUSIC_MODE: 'owned_licensed', MUSIC_S3_URI: 's3://bucket/track.m4a' }),
    ).toThrow(ConfigurationError);

    expect(() =>
      loadConfig({
        ...base,
        MUSIC_MODE: 'owned_licensed',
        MUSIC_S3_URI: 's3://bucket/track.m4a',
        MUSIC_LICENSE_REFERENCE: 'invoice-2026-001',
      }),
    ).not.toThrow();
  });

  it('refuses a non-s3 music URI so tracks cannot come from a public URL', () => {
    expect(() =>
      loadConfig({
        ...base,
        MUSIC_MODE: 'owned_licensed',
        MUSIC_S3_URI: 'https://example.com/track.mp3',
        MUSIC_LICENSE_REFERENCE: 'x',
      }),
    ).toThrow(/s3:\/\//);
  });

  it('refuses embedded_ai typography in production', () => {
    expect(() =>
      loadConfig({ ...base, ENVIRONMENT: 'prod', QUOTE_RENDER_MODE: 'embedded_ai' }),
    ).toThrow(/not permitted in prod/);
  });

  it('requires Bedrock model ids only when the Bedrock providers are selected', () => {
    expect(() => loadConfig({ ...base, PROVIDER_MODE: 'bedrock' })).toThrow(
      /BEDROCK_TEXT_MODEL_ID/,
    );
    expect(() =>
      loadConfig({
        ...base,
        PROVIDER_MODE: 'bedrock',
        BEDROCK_TEXT_MODEL_ID: 'some.model',
        BEDROCK_IMAGE_MODEL_ID: 'some.image.model',
      }),
    ).not.toThrow();
  });

  it('requires Meta identifiers only once publishing could really happen', () => {
    expect(() =>
      loadConfig({
        ...base,
        ENVIRONMENT: 'prod',
        PUBLISH_MODE: 'auto_publish',
        ALLOW_PRODUCTION_PUBLISH: 'true',
      }),
    ).toThrow(/META_SECRET_ARN/);
  });

  it('rejects malformed publish windows', () => {
    expect(() => loadConfig({ ...base, PUBLISH_WINDOWS: '9am-5pm' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...base, PUBLISH_WINDOWS: '22:00-02:00' })).toThrow(/wrap past/);
  });

  it('rejects a malformed Graph API version', () => {
    expect(() => loadConfig({ ...base, META_GRAPH_API_VERSION: '21.0' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('IMAGE_PROVIDER=openai', () => {
  const openai = {
    ...base,
    PROVIDER_MODE: 'bedrock',
    BEDROCK_TEXT_MODEL_ID: 'openai.gpt-5.6-luna',
    IMAGE_PROVIDER: 'openai',
    OPENAI_IMAGE_MODEL_ID: 'gpt-image-2',
    OPENAI_SECRET_ARN: 'arn:aws:secretsmanager:ap-southeast-2:1:secret:openai',
  } as NodeJS.ProcessEnv;

  it('does not require a Bedrock image model, because Bedrock only serves text', () => {
    const config = loadConfig(openai);
    expect(config.BEDROCK_IMAGE_MODEL_ID).toBeUndefined();
    expect(config.imageDimensionMode).toBe('aspect');
  });

  it('requires the key to come from Secrets Manager', () => {
    const { OPENAI_SECRET_ARN: _omitted, ...withoutArn } = openai;
    expect(() => loadConfig(withoutArn as NodeJS.ProcessEnv)).toThrow(ConfigurationError);
  });

  it('rejects a size whose edges are not divisible by 16', () => {
    // The exact 1080x1920 frame cannot be requested: 1080 is not a multiple of 16.
    expect(() => loadConfig({ ...openai, OPENAI_IMAGE_SIZE: '1080x1920' })).toThrow(
      /divisible by 16/,
    );
  });

  it('rejects a size that is not 9:16', () => {
    expect(() => loadConfig({ ...openai, OPENAI_IMAGE_SIZE: '1024x1536' })).toThrow(/not 9:16/);
  });

  it('rejects a size shorter than the validator would accept', () => {
    expect(() =>
      loadConfig({ ...openai, OPENAI_IMAGE_SIZE: '576x1024', MIN_IMAGE_HEIGHT: '1280' }),
    ).toThrow(/MIN_IMAGE_HEIGHT/);
  });

  it('accepts the documented defaults', () => {
    const config = loadConfig(openai);
    expect(config.OPENAI_IMAGE_SIZE).toBe('1152x2048');
    expect(config.OPENAI_IMAGE_QUALITY).toBe('high');
  });
});
