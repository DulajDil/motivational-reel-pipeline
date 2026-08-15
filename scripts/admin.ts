/**
 * Administrative CLI.
 *
 *   npm run admin -- list-jobs [--status MANUAL_REVIEW]
 *   npm run admin -- get-job --job <jobId>
 *   npm run admin -- list-reviews
 *   npm run admin -- approve --job <jobId> --by you@example.com [--notes "..."]
 *   npm run admin -- reject  --job <jobId> --by you@example.com
 *   npm run admin -- retry-job --job <jobId> --by you@example.com
 *   npm run admin -- retry-publish --job <jobId> --platform instagram --by you@example.com
 *   npm run admin -- trigger-batch [--count 5] [--date 2026-01-31]
 *
 * By default this talks to the LOCAL in-memory runtime, which is empty on every
 * invocation and therefore only useful for exercising the commands. Pass
 * `--remote` to invoke the deployed admin Lambda instead; that requires AWS
 * credentials and the function name in ADMIN_FUNCTION_NAME.
 */
import { resolve } from 'node:path';

import type { JobStatus, Platform } from '@mrp/shared';
import { createLocalRuntime, runAdminCommand, type AdminCommand } from '@mrp/handlers';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const buildCommand = (action: string): AdminCommand => {
  const jobId = arg('job') ?? '';
  const by = arg('by') ?? 'local-cli';

  switch (action) {
    case 'list-jobs':
      return { action: 'listJobs', status: arg('status') as JobStatus | undefined };
    case 'get-job':
      return { action: 'getJob', jobId };
    case 'list-reviews':
      return { action: 'listReviews' };
    case 'approve':
      return { action: 'approveReview', jobId, by, notes: arg('notes') };
    case 'reject':
      return { action: 'rejectReview', jobId, by, notes: arg('notes') };
    case 'retry-job':
      return { action: 'retryJob', jobId, by };
    case 'retry-publish':
      return { action: 'retryPublish', jobId, platform: arg('platform') as Platform, by };
    default:
      throw new Error(`Unknown action "${action}". Run with no arguments to see usage.`);
  }
};

const invokeLambda = async (functionName: string, payload: unknown): Promise<unknown> => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const client = new LambdaClient({});
  const response = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  );
  return JSON.parse(new TextDecoder().decode(response.Payload));
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const main = async (): Promise<void> => {
  const action = process.argv[2];
  if (!action || action.startsWith('--')) {
    console.log(
      [
        'Usage: npm run admin -- <action> [options]',
        '',
        'Actions:',
        '  list-jobs      [--status STATUS]',
        '  get-job        --job <jobId>',
        '  list-reviews',
        '  approve        --job <jobId> --by <who> [--notes "..."]',
        '  reject         --job <jobId> --by <who>',
        '  retry-job      --job <jobId> --by <who>',
        '  retry-publish  --job <jobId> --platform instagram|facebook --by <who>',
        '  trigger-batch  --remote [--count 5] [--date 2026-01-31]',
        '',
        'Add --remote to invoke the deployed Lambdas (needs AWS credentials and',
        'ADMIN_FUNCTION_NAME / BATCH_FUNCTION_NAME). Without it, an empty local',
        'runtime is used, which only exercises the command wiring.',
      ].join('\n'),
    );
    return;
  }

  if (action === 'trigger-batch') {
    if (!flag('remote')) {
      // Starting executions is a real side effect; never do it implicitly.
      throw new Error('trigger-batch requires --remote and BATCH_FUNCTION_NAME.');
    }
    const payload = {
      ...(arg('date') ? { date: arg('date') } : {}),
      ...(arg('count') ? { count: Number(arg('count')) } : {}),
    };
    console.log(
      JSON.stringify(await invokeLambda(requireEnv('BATCH_FUNCTION_NAME'), payload), null, 2),
    );
    return;
  }

  const command = buildCommand(action);

  if (flag('remote')) {
    console.log(
      JSON.stringify(await invokeLambda(requireEnv('ADMIN_FUNCTION_NAME'), command), null, 2),
    );
    return;
  }

  const runtime = createLocalRuntime({ root: resolve(process.cwd(), '.local/admin') });
  console.log(JSON.stringify(await runAdminCommand(command, runtime), null, 2));
};

main().catch((error: unknown) => {
  console.error('Admin command failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
