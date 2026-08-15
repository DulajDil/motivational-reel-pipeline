/**
 * Seed a day's worth of jobs into the local in-memory store and print what the
 * scheduler would do with them.
 *
 *   npm run seed -- --count 5
 *
 * Renders nothing and calls nothing. Useful for eyeballing quote variety,
 * deduplication behaviour and slot distribution before spending on a real run.
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { distributeSlots, localDate } from '@mrp/shared';
import { createLocalRuntime } from '@mrp/handlers';
import { createJob, generateQuoteAndMetadata } from '@mrp/handlers';

const root = resolve(process.cwd(), '.local/seed');

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const main = async (): Promise<void> => {
  await mkdir(root, { recursive: true });
  const runtime = createLocalRuntime({ root });

  const count = Number(arg('count', String(runtime.config.DAILY_TARGET)));
  const date = arg('date', localDate(new Date(), runtime.config.SCHEDULE_TIMEZONE));
  const slotMinutes = distributeSlots(count, runtime.config.publishWindows);

  console.log(`\nSeeding ${count} jobs for ${date} (${runtime.config.SCHEDULE_TIMEZONE})\n`);

  for (let slot = 0; slot < count; slot += 1) {
    const state = await createJob({ date, slot }, runtime);
    const withContent = await generateQuoteAndMetadata(state, runtime);
    const job = await runtime.repository.getJob(withContent.jobId);

    const minute = slotMinutes[slot] ?? 0;
    const localTime = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

    console.log(`slot ${slot}  ${localTime}  ${job?.jobId}`);
    console.log(`   quote : ${job?.content?.quote.text}`);
    console.log(`   scene : ${job?.content?.sceneConcept}`);
    console.log(`   print : ${job?.content?.quote.fingerprint.slice(0, 16)}`);
    console.log();
  }

  const quotes = await runtime.repository.recentQuotes(count);
  const unique = new Set(quotes.map((entry) => entry.fingerprint)).size;
  console.log(`${unique}/${quotes.length} distinct quote fingerprints reserved.`);
  console.log('Nothing was rendered and nothing was published.\n');
};

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
