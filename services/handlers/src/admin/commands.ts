import {
  NonRetryableError,
  TERMINAL_JOB_STATUSES,
  type Job,
  type JobEvent,
  type JobStatus,
  type Platform,
  type ReviewItem,
} from '@mrp/shared';

import type { Runtime } from '../context.js';

/**
 * Administrative operations.
 *
 * Shared by the admin Lambda and the local CLI so both behave identically. Every
 * mutating command is deliberately narrow: nothing here can publish, delete an
 * asset, or bypass the production guard.
 */

export type AdminCommand =
  | { action: 'listJobs'; status?: JobStatus; limit?: number }
  | { action: 'getJob'; jobId: string }
  | { action: 'listReviews'; limit?: number }
  | { action: 'approveReview'; jobId: string; by: string; notes?: string }
  | { action: 'rejectReview'; jobId: string; by: string; notes?: string }
  | { action: 'retryJob'; jobId: string; by: string }
  | { action: 'retryPublish'; jobId: string; platform: Platform; by: string };

export type AdminResult =
  | { action: 'listJobs'; jobs: Array<Pick<Job, 'jobId' | 'status' | 'publishDate' | 'slot' | 'updatedAt'>> }
  | { action: 'getJob'; job: Job; events: JobEvent[] }
  | { action: 'listReviews'; reviews: ReviewItem[] }
  | { action: 'approveReview' | 'rejectReview'; review: ReviewItem }
  | { action: 'retryJob' | 'retryPublish'; jobId: string; status: JobStatus; note: string };

/** Steps a job may safely be rewound to. Anything published is excluded. */
const SAFE_RETRY_STATUSES: JobStatus[] = ['FAILED', 'MANUAL_REVIEW', 'PARTIALLY_COMPLETED'];

export const runAdminCommand = async (
  command: AdminCommand,
  runtime: Runtime,
): Promise<AdminResult> => {
  const { repository, logger } = runtime;

  switch (command.action) {
    case 'listJobs': {
      const jobs = await repository.listJobs({
        status: command.status ?? 'MANUAL_REVIEW',
        limit: command.limit ?? 25,
      });
      return {
        action: 'listJobs',
        jobs: jobs.map(({ jobId, status, publishDate, slot, updatedAt }) => ({
          jobId,
          status,
          publishDate,
          slot,
          updatedAt,
        })),
      };
    }

    case 'getJob': {
      const job = await repository.getJob(command.jobId);
      if (!job) throw new NonRetryableError(`Job ${command.jobId} not found`);
      return { action: 'getJob', job, events: await repository.listEvents(command.jobId) };
    }

    case 'listReviews':
      return { action: 'listReviews', reviews: await repository.listOpenReviews(command.limit) };

    case 'approveReview': {
      const review = await repository.resolveReview(
        command.jobId,
        'APPROVED',
        command.by,
        command.notes,
      );
      // Approval only makes the job eligible again; it does not itself publish.
      await repository.updateJob(command.jobId, { status: 'VIDEO_VALIDATED' });
      await repository.appendEvent(command.jobId, {
        at: runtime.clock().toISOString(),
        type: 'REVIEW_APPROVED',
        actor: 'admin',
        detail: { by: command.by, notes: command.notes },
      });
      logger.info('Review approved', { jobId: command.jobId, by: command.by });
      return { action: 'approveReview', review };
    }

    case 'rejectReview': {
      const review = await repository.resolveReview(
        command.jobId,
        'REJECTED',
        command.by,
        command.notes,
      );
      await repository.updateJob(command.jobId, { status: 'CANCELLED' });
      await repository.appendEvent(command.jobId, {
        at: runtime.clock().toISOString(),
        type: 'REVIEW_REJECTED',
        actor: 'admin',
        detail: { by: command.by, notes: command.notes },
      });
      return { action: 'rejectReview', review };
    }

    case 'retryJob': {
      const job = await repository.getJob(command.jobId);
      if (!job) throw new NonRetryableError(`Job ${command.jobId} not found`);
      if (!SAFE_RETRY_STATUSES.includes(job.status)) {
        throw new NonRetryableError(
          `Job ${command.jobId} is ${job.status}; only ${SAFE_RETRY_STATUSES.join(', ')} may be retried.`,
        );
      }
      // Rewind to the last step that produced no external side effect.
      const target: JobStatus = job.render ? 'VIDEO_VALIDATED' : 'CREATED';
      await repository.updateJob(command.jobId, {
        status: target,
        failureReason: undefined,
        generationAttempts: 0,
      });
      await repository.appendEvent(command.jobId, {
        at: runtime.clock().toISOString(),
        type: 'JOB_RETRY_REQUESTED',
        actor: 'admin',
        detail: { by: command.by, from: job.status, to: target },
      });
      return {
        action: 'retryJob',
        jobId: command.jobId,
        status: target,
        note: 'Job rewound. Start a new execution to resume.',
      };
    }

    case 'retryPublish': {
      const publishState = await repository.getPublishState(command.jobId, command.platform);
      if (!publishState) {
        throw new NonRetryableError(
          `No publish state for ${command.jobId}/${command.platform}`,
        );
      }
      if (publishState.status === 'PUBLISHED') {
        // Reposting an already-live Reel is an explicit, separate decision.
        throw new NonRetryableError(
          `${command.platform} already published media ${publishState.mediaId}. Reposting is not offered here; create a new job instead.`,
        );
      }
      const moved = await repository.transitionPublishState(
        command.jobId,
        command.platform,
        ['FAILED', 'RETRYABLE'],
        { status: 'PENDING', attempts: 0, lastErrorCode: undefined },
      );
      if (!moved) {
        throw new NonRetryableError(
          `${command.platform} publish state is ${publishState.status}; not retryable.`,
        );
      }
      await repository.appendEvent(command.jobId, {
        at: runtime.clock().toISOString(),
        type: 'PUBLISH_RETRY_REQUESTED',
        actor: 'admin',
        detail: { by: command.by, platform: command.platform },
      });
      const job = await repository.getJob(command.jobId);
      return {
        action: 'retryPublish',
        jobId: command.jobId,
        status: job?.status ?? 'MANUAL_REVIEW',
        note: `${command.platform} reset to PENDING. Start a new execution to resume.`,
      };
    }

    default: {
      const exhaustive: never = command;
      throw new NonRetryableError(`Unknown admin action: ${JSON.stringify(exhaustive)}`);
    }
  }
};

export { TERMINAL_JOB_STATUSES };
