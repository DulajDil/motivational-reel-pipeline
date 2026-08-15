import {
  GuardTrippedError,
  Metrics,
  TERMINAL_JOB_STATUSES,
  deriveJobId,
  emitMetric,
  jobIdempotencyKey,
  localDate,
  type Job,
  type WorkflowState,
} from '@mrp/shared';

import { getRuntime, type Runtime } from '../context.js';

/**
 * CreateJob.
 *
 * The single entry point for a unit of work, and the first idempotency barrier.
 *
 * `jobId` is a pure function of (date, slot, configVersion), so a duplicated
 * schedule event resolves to the same job rather than creating a second one. If
 * that job has already completed, its stored result is returned and no asset is
 * regenerated and no post is repeated.
 */

export interface CreateJobInput {
  /** Local publish date. Defaults to today in SCHEDULE_TIMEZONE. */
  date?: string;
  slot: number;
  /** Set by an operator when a deliberate re-run of a completed slot is wanted. */
  configVersionOverride?: string;
}

export const createJob = async (
  input: CreateJobInput,
  runtime: Runtime = getRuntime(),
): Promise<WorkflowState> => {
  const { config, repository, logger, clock } = runtime;

  const publishDate = input.date ?? localDate(clock(), config.SCHEDULE_TIMEZONE);
  const configVersion = input.configVersionOverride ?? config.CONFIG_VERSION;
  const identity = { date: publishDate, slot: input.slot, configVersion };

  const jobId = deriveJobId(identity);
  const idempotencyKey = jobIdempotencyKey(identity);
  const log = logger.child({ jobId, publishDate, slot: input.slot });

  // Guard 1: the kill switch halts new work without deleting anything.
  if (await runtime.killSwitch.isEngaged()) {
    emitMetric(Metrics.killSwitchBlocked, 1, { Environment: config.ENVIRONMENT });
    throw new GuardTrippedError('kill_switch', 'Kill switch is engaged; no new jobs will start.');
  }

  // Guard 2: soft daily spend budget.
  if (config.COST_GUARD_ENABLED) {
    const estimate = estimateJobCostUsd();
    const guard = await repository.consumeCostBudget(
      `daily#${publishDate}`,
      estimate,
      config.DAILY_COST_BUDGET_USD,
    );
    if (!guard.allowed) {
      emitMetric(Metrics.costGuardTripped, 1, { Environment: config.ENVIRONMENT, Period: 'daily' });
      throw new GuardTrippedError(
        'daily_cost_budget',
        `Daily cost budget of $${config.DAILY_COST_BUDGET_USD} reached; stopping new work.`,
      );
    }
  }

  const { acquired, record } = await repository.acquireIdempotency(
    idempotencyKey,
    jobId,
    60 * 60 * 24 * 30,
  );

  if (!acquired && record.state === 'COMPLETED') {
    log.info('Idempotent replay: job already completed, returning stored result');
    return {
      jobId: record.jobId,
      idempotencyKey,
      publishDate,
      slot: input.slot,
      status: 'COMPLETED',
      alreadyComplete: true,
      platforms: config.ENABLED_PLATFORMS,
    };
  }

  const existing = await repository.getJob(jobId);
  if (existing) {
    const terminal = TERMINAL_JOB_STATUSES.includes(existing.status);
    log.info('Job already exists', { status: existing.status, terminal });
    return {
      jobId,
      idempotencyKey,
      publishDate,
      slot: input.slot,
      status: existing.status,
      alreadyComplete: terminal,
      generationAttempts: existing.generationAttempts,
      platforms: config.ENABLED_PLATFORMS,
    };
  }

  const now = clock().toISOString();
  const job: Job = {
    jobId,
    idempotencyKey,
    status: 'CREATED',
    publishDate,
    slot: input.slot,
    configVersion,
    publishMode: config.PUBLISH_MODE,
    createdAt: now,
    updatedAt: now,
    platforms: {},
    generationAttempts: 0,
  };

  const { created } = await repository.createJob(job);
  if (created) {
    await repository.appendEvent(jobId, {
      at: now,
      type: 'JOB_CREATED',
      actor: 'workflow',
      detail: { publishDate, slot: input.slot, configVersion, publishMode: config.PUBLISH_MODE },
    });
    emitMetric(Metrics.jobsCreated, 1, { Environment: config.ENVIRONMENT });
  }

  return {
    jobId,
    idempotencyKey,
    publishDate,
    slot: input.slot,
    status: 'CREATED',
    alreadyComplete: false,
    generationAttempts: 0,
    platforms: config.ENABLED_PLATFORMS,
  };
};

/**
 * Very rough per-job cost estimate used only to drive the soft guard. It is a
 * budget tripwire, not accounting - real spend is tracked by AWS Budgets.
 */
export const estimateJobCostUsd = (): number => 0.25;

// No Lambda entry point: this step runs inside PrepareContent.
