import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

import {
  createLogger,
  deriveJobId,
  getConfig,
  localDate,
  NonRetryableError,
  StaticKillSwitch,
  SsmKillSwitch,
} from '@mrp/shared';

/**
 * Scheduled batch trigger.
 *
 * Starts one Standard execution per content slot for the day. The execution name
 * is the deterministic jobId, so EventBridge re-delivery or an accidental double
 * schedule cannot start a second execution for the same slot - Step Functions
 * rejects the duplicate name itself, before any Lambda runs.
 */

const logger = createLogger('batch-trigger');

export interface BatchTriggerEvent {
  /** Defaults to today in SCHEDULE_TIMEZONE. */
  date?: string;
  /** Defaults to DAILY_TARGET. */
  count?: number;
  /** Start at this slot index. Used by the admin CLI to backfill one slot. */
  fromSlot?: number;
}

export interface BatchTriggerResult {
  date: string;
  started: string[];
  skipped: Array<{ jobId: string; reason: string }>;
}

export const handler = async (event: BatchTriggerEvent = {}): Promise<BatchTriggerResult> => {
  const config = getConfig();
  const stateMachineArn = process.env.STATE_MACHINE_ARN;
  if (!stateMachineArn) throw new NonRetryableError('STATE_MACHINE_ARN is not set');

  const killSwitch = config.KILL_SWITCH_PARAMETER_NAME
    ? new SsmKillSwitch(config.KILL_SWITCH_PARAMETER_NAME)
    : new StaticKillSwitch(config.KILL_SWITCH_ENABLED);

  const date = event.date ?? localDate(new Date(), config.SCHEDULE_TIMEZONE);
  const count = event.count ?? config.DAILY_TARGET;
  const fromSlot = event.fromSlot ?? 0;

  if (await killSwitch.isEngaged()) {
    logger.warn('Kill switch engaged; starting no executions', { date });
    return { date, started: [], skipped: [{ jobId: '-', reason: 'kill_switch' }] };
  }

  const client = new SFNClient({ region: config.AWS_REGION });
  const started: string[] = [];
  const skipped: BatchTriggerResult['skipped'] = [];

  for (let slot = fromSlot; slot < fromSlot + count; slot += 1) {
    const jobId = deriveJobId({ date, slot, configVersion: config.CONFIG_VERSION });
    try {
      await client.send(
        new StartExecutionCommand({
          stateMachineArn,
          // Deterministic execution name = the duplicate-delivery guard.
          name: jobId,
          input: JSON.stringify({ date, slot }),
        }),
      );
      started.push(jobId);
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'ExecutionAlreadyExists') {
        skipped.push({ jobId, reason: 'execution_already_exists' });
        continue;
      }
      throw error;
    }
  }

  logger.info('Batch triggered', { date, started: started.length, skipped: skipped.length });
  return { date, started, skipped };
};
