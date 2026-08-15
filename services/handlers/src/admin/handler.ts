import { redact } from '@mrp/shared';

import { getRuntime } from '../context.js';
import { runAdminCommand, type AdminCommand, type AdminResult } from './commands.js';

/**
 * Administrative Lambda.
 *
 * Invoked directly (no public endpoint). Read-mostly: it can inspect jobs,
 * resolve review items and rewind a failed job to a safe step. It cannot
 * publish, and it cannot delete assets.
 */
export const handler = async (command: AdminCommand): Promise<AdminResult> => {
  const result = await runAdminCommand(command, getRuntime());
  return redact(result);
};
