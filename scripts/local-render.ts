/**
 * Render one sample Reel locally, without running the rest of the pipeline.
 *
 *   npm run render:local
 *   npm run render:local -- "Your own quote goes here"
 *
 * Uses the procedural stand-in illustration and a silent audio track, so there
 * is no model call, no network and no licensing question. Prints the ffprobe
 * verification of the result.
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { FileSystemObjectStore, renderSeed, s3Keys } from '@mrp/shared';
import { DEFAULT_TEXT_SAFE_AREAS, MockImageGenerator } from '@mrp/providers';
import { profileFor, probeVideo, renderReel, validateProbe } from '@mrp/renderer';

const root = resolve(process.cwd(), '.local/render');

const main = async (): Promise<void> => {
  const quote =
    process.argv.slice(2).join(' ').trim() ||
    'Begin again as many times as the morning allows';

  await mkdir(root, { recursive: true });
  const store = new FileSystemObjectStore(root, 'local-assets');

  const jobId = 'local-sample';
  const seed = renderSeed(jobId);
  const textSafeArea = DEFAULT_TEXT_SAFE_AREAS.upper_left;

  const image = await new MockImageGenerator().generate({
    jobId,
    sceneConcept: 'a person sitting cross-legged by a wide window, a mug resting on the sill',
    textSafeArea,
    quoteRenderMode: 'overlay',
    seed,
    width: 1080,
    height: 1920,
    attempt: 0,
  });
  const source = await store.put({
    key: s3Keys.image(jobId, 0),
    body: image.data,
    contentType: 'image/png',
  });

  const result = await renderReel(
    {
      jobId,
      quote,
      textSafeArea,
      quoteRenderMode: 'overlay',
      durationSeconds: Number(process.env.REEL_DURATION_SECONDS ?? 14),
      seed,
      brandHandle: process.env.BRAND_HANDLE,
      music: { mode: 'silent', volumeDb: -18 },
      image: { key: source.key, bytes: image.data, source },
    },
    {
      store,
      workDir: resolve(root, 'work'),
      fontDir: resolve(process.cwd(), 'renderer/fonts'),
      fontOverride: process.env.QUOTE_FONT_PATH,
    },
  );

  const probe = await probeVideo(result.localVideoPath);
  const report = validateProbe(probe, profileFor('instagram'));

  console.log('\nRendered:', result.localVideoPath);
  console.log('Quote   :', quote);
  console.log('Font    :', result.manifest.font.family);
  console.log('Licence :', result.manifest.font.license);
  console.log('FFmpeg  :', result.manifest.ffmpegVersion);
  console.log('Checksum:', result.manifest.outputChecksumSha256);
  console.log('Manifest:', store.pathFor(s3Keys.manifest(jobId)));
  console.log('Cover   :', store.pathFor(s3Keys.thumbnail(jobId)));
  console.log('\nffprobe verification');
  console.log(JSON.stringify(report, null, 2));

  if (!report.passed) {
    console.error('\nValidation FAILED:', report.failures.join(', '));
    process.exitCode = 1;
  } else {
    console.log('\nValidation passed.\n');
  }
};

main().catch((error: unknown) => {
  console.error('Local render failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
