import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DynamoJobRepository,
  NonRetryableError,
  S3ObjectStore,
  createLogger,
  emitMetric,
  getConfig,
  renderSeed,
  Metrics,
  type Job,
  type WorkflowState,
} from '@mrp/shared';
import { ConfiguredMusicProvider } from '@mrp/providers';

import { profileFor } from './profiles.js';
import { probeVideo, validateProbe } from './probe.js';
import { cleanupWorkDir, renderReel } from './render.js';

/**
 * RenderReel Lambda (container image with FFmpeg).
 *
 * Renders, probes and stores the output plus its manifest. It deliberately runs
 * ffprobe here as well as in the ValidateVideo state: a render that cannot even
 * be probed is a failed render, and failing fast avoids a pointless state
 * transition.
 */

const logger = createLogger('renderer');

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new NonRetryableError(`${name} is not set on the renderer function`);
  return value;
};

export const handler = async (state: WorkflowState): Promise<WorkflowState> => {
  const config = getConfig();
  const log = logger.child({ jobId: state.jobId });

  const repository = new DynamoJobRepository({
    tableName: requireEnv('TABLE_NAME'),
    region: config.AWS_REGION,
  });
  const store = new S3ObjectStore({
    bucket: requireEnv('ASSETS_BUCKET'),
    region: config.AWS_REGION,
  });

  const job: Job | undefined = await repository.getJob(state.jobId);
  if (!job) throw new NonRetryableError(`Job ${state.jobId} not found`);
  if (!job.content || !job.image) {
    throw new NonRetryableError(`Job ${state.jobId} has no validated image to render`);
  }

  // A completed render is not repeated: re-delivery returns the stored result.
  if (job.render && job.status !== 'IMAGE_READY') {
    log.info('Render already present, skipping', { status: job.status });
    return { ...state, status: job.status };
  }

  const music = new ConfiguredMusicProvider({
    mode: config.MUSIC_MODE,
    s3Uri: config.MUSIC_S3_URI,
    licenseReference: config.MUSIC_LICENSE_REFERENCE,
    volumeDb: config.MUSIC_VOLUME_DB,
    store,
  });
  const selection = await music.resolve();
  const musicBytes = await music.fetch(selection);

  const workDir = join(tmpdir(), 'mrp-render');

  try {
    const result = await renderReel(
      {
        jobId: job.jobId,
        quote: job.content.quote.text,
        textSafeArea: job.content.textSafeArea,
        quoteRenderMode: config.QUOTE_RENDER_MODE,
        durationSeconds: config.REEL_DURATION_SECONDS,
        seed: renderSeed(job.jobId),
        brandHandle: config.BRAND_HANDLE,
        music: selection,
        musicBytes,
        image: {
          key: job.image.key,
          bytes: await store.get(job.image.key),
          source: job.image,
        },
      },
      {
        store,
        workDir,
        fontDir: process.env.FONT_DIR ?? '/opt/fonts',
        fontOverride: config.QUOTE_FONT_PATH,
      },
    );

    const probe = await probeVideo(result.localVideoPath);
    const report = validateProbe(probe, profileFor('instagram'));

    await repository.updateJob(
      job.jobId,
      { render: result.manifest, videoValidation: report, status: 'RENDERED' },
      ['IMAGE_READY', 'RENDERED'],
    );
    await repository.appendEvent(job.jobId, {
      at: new Date().toISOString(),
      type: 'RENDER_COMPLETED',
      actor: 'workflow',
      detail: {
        checksum: result.manifest.outputChecksumSha256,
        sizeBytes: result.video.sizeBytes,
        musicMode: selection.mode,
        probePassed: report.passed,
      },
    });

    emitMetric(Metrics.reelsRendered, 1, { Environment: config.ENVIRONMENT });
    log.info('Render complete', {
      checksum: result.manifest.outputChecksumSha256,
      durationSeconds: report.durationSeconds,
    });

    return { ...state, status: 'RENDERED' };
  } finally {
    await cleanupWorkDir(workDir, state.jobId);
  }
};
