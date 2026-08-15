/**
 * Full offline dry run.
 *
 *   npm run dry-run
 *
 * Runs one complete job through the same handlers the Step Functions state
 * machine calls: quote, image, validation, FFmpeg render, ffprobe validation,
 * scheduling and both publish branches. Providers are mocked, storage is the
 * local filesystem, and the publishers build the exact Meta payloads but make no
 * network call.
 *
 * Requires: FFmpeg on PATH. Requires no AWS credentials.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createLocalRuntime, defaultLocalPaths, runJobLocally } from '@mrp/handlers';
import { DryRunPublisher } from '@mrp/providers';

const root = resolve(process.cwd(), '.local/dry-run');

const main = async (): Promise<void> => {
  await mkdir(root, { recursive: true });

  const runtime = createLocalRuntime({
    root,
    env: {
      PUBLISH_MODE: 'dry_run',
      PUBLISH_WINDOWS: '00:00-23:59',
      BRAND_HANDLE: process.env.BRAND_HANDLE ?? '',
      REEL_DURATION_SECONDS: process.env.REEL_DURATION_SECONDS ?? '14',
    },
  });

  const paths = defaultLocalPaths(root);
  const slot = Number(process.env.SLOT ?? 0);

  console.log(`\nDry run starting (slot ${slot})`);
  console.log(`  publish mode : ${runtime.config.PUBLISH_MODE}`);
  console.log(`  quote mode   : ${runtime.config.QUOTE_RENDER_MODE}`);
  console.log(`  music mode   : ${runtime.config.MUSIC_MODE}`);
  console.log(`  output root  : ${root}\n`);

  const result = await runJobLocally({
    input: { slot },
    runtime,
    workDir: paths.workDir,
    fontDir: paths.fontDir,
  });

  const job = result.job;
  console.log('Quote      :', job.content?.quote.text);
  console.log('Caption    :', job.content?.caption.replace(/\n/g, ' / '));
  console.log('Alt text   :', job.content?.altText);
  console.log('Hashtags   :', job.content?.hashtags.join(' '));
  console.log('Video      :', result.videoPath);
  console.log('Checksum   :', job.render?.outputChecksumSha256);
  console.log('Duration   :', job.videoValidation?.durationSeconds, 's');
  console.log('Dimensions :', `${job.videoValidation?.width}x${job.videoValidation?.height}`);
  console.log('Codecs     :', job.videoValidation?.videoCodec, '/', job.videoValidation?.audioCodec);
  console.log('Font       :', job.render?.font.family, `(${job.render?.font.license})`);
  console.log('Status     :', result.state.status);
  console.log('Platforms  :', JSON.stringify(result.summary?.platforms, null, 2));

  // Dump the Meta payloads that WOULD have been sent, for inspection.
  const payloads: Record<string, unknown> = {};
  for (const platform of runtime.config.ENABLED_PLATFORMS) {
    const publisher = await runtime.publisherFor(platform);
    if (publisher instanceof DryRunPublisher) payloads[platform] = publisher.calls;
  }
  const payloadPath = resolve(root, 'meta-payloads.json');
  await writeFile(payloadPath, JSON.stringify(payloads, null, 2));

  console.log('\nMeta payloads that were NOT sent:', payloadPath);
  console.log('No Meta endpoint was contacted. No AWS credentials were used.\n');
};

main().catch((error: unknown) => {
  console.error('\nDry run failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && /ffmpeg|ENOENT/i.test(error.message)) {
    console.error('\nFFmpeg appears to be missing. Install it first:');
    console.error('  macOS  : brew install ffmpeg');
    console.error('  Debian : sudo apt-get install ffmpeg\n');
  }
  process.exitCode = 1;
});
