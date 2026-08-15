import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DynamoJobRepository,
  Metrics,
  NonRetryableError,
  S3ObjectStore,
  createLogger,
  emitMetric,
  getConfig,
  type VideoValidationReport,
  type WorkflowState,
} from '@mrp/shared';

import { profileFor } from './profiles.js';
import { probeVideo, validateProbe } from './probe.js';

/**
 * ValidateVideo.
 *
 * Runs in the renderer container because it needs a real `ffprobe`. It
 * re-downloads the stored output and probes it independently of the render step,
 * so what is validated is exactly the object that would be published, then
 * checks it against every enabled platform's profile.
 *
 * A failure here is terminal: the workflow will not reach a publish state.
 */

const logger = createLogger('validate-video');

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new NonRetryableError(`${name} is not set on the validator function`);
  return value;
};

export interface ValidateVideoResult extends WorkflowState {
  videoValid: boolean;
  videoFailures: string[];
}

export const handler = async (state: WorkflowState): Promise<ValidateVideoResult> => {
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

  const job = await repository.getJob(state.jobId);
  if (!job?.render) throw new NonRetryableError(`Job ${state.jobId} has no render to validate`);

  const workDir = await mkdtemp(join(tmpdir(), 'mrp-validate-'));
  try {
    const bytes = await store.get(job.render.output.key);
    const localPath = join(workDir, 'reel.mp4');
    await writeFile(localPath, bytes);

    const probe = await probeVideo(localPath);

    const failures: string[] = [];
    let report: VideoValidationReport | undefined;
    for (const platform of config.ENABLED_PLATFORMS) {
      const platformReport = validateProbe(probe, profileFor(platform));
      report ??= platformReport;
      failures.push(...platformReport.failures.map((failure) => `${platform}:${failure}`));
    }

    const merged: VideoValidationReport = {
      ...(report as VideoValidationReport),
      passed: failures.length === 0,
      failures,
    };

    await repository.updateJob(state.jobId, {
      videoValidation: merged,
      ...(merged.passed ? { status: 'VIDEO_VALIDATED' as const } : { status: 'FAILED' as const }),
    });
    await repository.appendEvent(state.jobId, {
      at: new Date().toISOString(),
      type: merged.passed ? 'VIDEO_VALIDATED' : 'VIDEO_REJECTED',
      actor: 'workflow',
      detail: {
        failures,
        durationSeconds: merged.durationSeconds,
        sizeBytes: merged.sizeBytes,
        checksum: job.render.outputChecksumSha256,
      },
    });

    emitMetric(merged.passed ? Metrics.videosValidated : Metrics.videosRejected, 1, {
      Environment: config.ENVIRONMENT,
    });

    if (!merged.passed) {
      log.error('Rendered video failed validation; refusing to publish', { failures });
      throw new NonRetryableError('Rendered video failed platform validation', {
        code: 'VIDEO_VALIDATION_FAILED',
        context: { failures },
      });
    }

    log.info('Video validated', {
      durationSeconds: merged.durationSeconds,
      sizeBytes: merged.sizeBytes,
    });
    return { ...state, status: 'VIDEO_VALIDATED', videoValid: true, videoFailures: [] };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};
