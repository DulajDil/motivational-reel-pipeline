import { Metrics, emitMetric, type JobStatus, type WorkflowState } from '@mrp/shared';

import { getRuntime, type Runtime } from '../context.js';

/**
 * Terminal catch for the workflow.
 *
 * Routes a failed job to the right resting place instead of letting it retry:
 *   ManualReviewRequiredError -> review queue, assets retained
 *   GuardTrippedError         -> quietly cancelled, this is a deliberate stop
 *   everything else           -> FAILED, alarmed
 *
 * Nothing is deleted here. Rolling back a *successful* external post is not
 * possible from this system - see docs/operations.md.
 */

export interface FailureInput extends WorkflowState {
  error?: { Error?: string; Cause?: string };
}

export const handleFailure = async (
  input: FailureInput,
  runtime: Runtime = getRuntime(),
): Promise<WorkflowState> => {
  const { config, repository, logger } = runtime;
  const errorName = input.error?.Error ?? 'UnknownError';
  const cause = (input.error?.Cause ?? '').slice(0, 1_000);

  let status: JobStatus;
  let reviewReason: string | undefined;

  switch (errorName) {
    case 'ManualReviewRequiredError':
      status = 'MANUAL_REVIEW';
      reviewReason = 'manual_review_required';
      break;
    case 'GuardTrippedError':
      status = 'CANCELLED';
      break;
    default:
      status = 'FAILED';
  }

  await repository.updateJob(input.jobId, {
    status,
    failureReason: `${errorName}: ${cause}`.slice(0, 900),
    ...(reviewReason ? { reviewReason } : {}),
  });
  await repository.appendEvent(input.jobId, {
    at: runtime.clock().toISOString(),
    type: 'JOB_FAILED',
    actor: 'workflow',
    detail: { errorName, status, cause },
  });

  if (status === 'MANUAL_REVIEW') {
    await repository.openReview(input.jobId, reviewReason ?? 'manual_review_required');
    emitMetric(Metrics.manualReviewQueued, 1, { Environment: config.ENVIRONMENT });
  } else if (status === 'FAILED') {
    emitMetric(Metrics.jobsFailed, 1, { Environment: config.ENVIRONMENT, Reason: errorName });
  }

  logger.error('Job terminated', { jobId: input.jobId, errorName, status });
  return { ...input, status };
};

export const handler = async (input: FailureInput): Promise<WorkflowState> => handleFailure(input);
