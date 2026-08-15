import { join } from 'node:path';

import {
  NonRetryableError,
  renderSeed,
  type Job,
  type VideoValidationReport,
  type WorkflowState,
} from '@mrp/shared';
import { profileFor, probeVideo, renderReel, validateProbe } from '@mrp/renderer';

import type { Runtime } from '../context.js';
import { complete, type CompleteResult } from '../states/complete.js';
import type { CreateJobInput } from '../states/create-job.js';
import { prepareContent } from '../states/prepare-content.js';
import {
  checkPublishStatus,
  createPublishContainer,
  finalisePublish,
  type PublishBranchState,
} from '../states/publish.js';
import { scheduleOrPublish } from '../states/schedule-or-publish.js';

/**
 * In-process orchestrator.
 *
 * Runs exactly the same handlers as the Step Functions state machine, in the
 * same order, with the same bounded loops. It exists so a full job can be
 * exercised end to end offline - by `npm run dry-run` and by the integration
 * tests - without deploying anything.
 *
 * It is a faithful mirror, not a second implementation: every step below is a
 * call into the production handler.
 */

export interface RunJobOptions {
  input: CreateJobInput;
  runtime: Runtime;
  workDir: string;
  fontDir: string;
  /** Skips FFmpeg. Only used when a machine has no ffmpeg available. */
  skipRender?: boolean;
}

export interface RunJobResult {
  state: WorkflowState;
  job: Job;
  summary: CompleteResult['summary'] | undefined;
  videoPath?: string | undefined;
}

export const runJobLocally = async (options: RunJobOptions): Promise<RunJobResult> => {
  const { runtime } = options;

  // One call, exactly as the state machine does it: PrepareContent covers job
  // creation, quote generation and the bounded image generate/validate loop.
  let state: WorkflowState = await prepareContent(options.input, runtime);
  if (state.alreadyComplete) {
    const job = await runtime.repository.getJob(state.jobId);
    return { state, job: job as Job, summary: undefined };
  }

  let videoPath: string | undefined;
  if (!options.skipRender) {
    const job = await runtime.repository.getJob(state.jobId);
    if (!job?.content || !job.image) throw new NonRetryableError('Job is not ready to render');

    const music = await runtime.providers.music.resolve();
    const result = await renderReel(
      {
        jobId: job.jobId,
        quote: job.content.quote.text,
        textSafeArea: job.content.textSafeArea,
        quoteRenderMode: runtime.config.QUOTE_RENDER_MODE,
        durationSeconds: runtime.config.REEL_DURATION_SECONDS,
        seed: renderSeed(job.jobId),
        brandHandle: runtime.config.BRAND_HANDLE,
        music,
        musicBytes: await runtime.providers.music.fetch(music),
        image: {
          key: job.image.key,
          bytes: await runtime.store.get(job.image.key),
          source: job.image,
        },
      },
      { store: runtime.store, workDir: options.workDir, fontDir: options.fontDir },
    );
    videoPath = result.localVideoPath;

    // ValidateVideo, run locally against the file that was actually written.
    const probe = await probeVideo(result.localVideoPath);
    const failures: string[] = [];
    let report: VideoValidationReport | undefined;
    for (const platform of runtime.config.ENABLED_PLATFORMS) {
      const platformReport = validateProbe(probe, profileFor(platform));
      report ??= platformReport;
      failures.push(...platformReport.failures.map((failure) => `${platform}:${failure}`));
    }
    const merged: VideoValidationReport = {
      ...(report as VideoValidationReport),
      passed: failures.length === 0,
      failures,
    };

    await runtime.repository.updateJob(state.jobId, {
      render: result.manifest,
      videoValidation: merged,
      status: merged.passed ? 'VIDEO_VALIDATED' : 'FAILED',
    });
    if (!merged.passed) {
      throw new NonRetryableError(`Rendered video failed validation: ${failures.join(', ')}`);
    }
    state = { ...state, status: 'VIDEO_VALIDATED' };
  }

  const decision = await scheduleOrPublish(state, runtime);
  state = decision;

  if (decision.decision === 'proceed' || decision.decision === 'deferred') {
    for (const platform of decision.publishTargets) {
      let branch: PublishBranchState = { ...state, platform };
      branch = await createPublishContainer(branch, runtime);
      if (branch.publishSkipped) continue;

      for (
        let poll = 0;
        poll < runtime.config.MAX_CONTAINER_POLL_ATTEMPTS &&
        branch.containerStatus !== 'FINISHED';
        poll += 1
      ) {
        branch = await checkPublishStatus(branch, runtime);
      }
      if (branch.containerStatus === 'FINISHED') {
        branch = await finalisePublish(branch, runtime);
      }
    }
  }

  const finished = await complete(state, runtime);
  const job = await runtime.repository.getJob(state.jobId);

  return { state: finished, job: job as Job, summary: finished.summary, videoPath };
};

export const defaultLocalPaths = (root: string): { workDir: string; fontDir: string } => ({
  workDir: join(root, 'work'),
  fontDir: join(process.cwd(), 'renderer', 'fonts'),
});
