import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  RetryableError,
  sha256Hex,
  type MusicSelection,
  type ObjectStore,
  type QuoteRenderMode,
  type RenderManifest,
  type StoredObject,
  type TextSafeArea,
  s3Keys,
} from '@mrp/shared';

import { assertRenderCapabilities, resolveFfmpeg } from './ffmpeg-bin.js';
import { buildRenderCommand, buildThumbnailCommand } from './ffmpeg-args.js';
import { resolveFont } from './font.js';
import { RENDER_PROFILE } from './profiles.js';

const execFileAsync = promisify(execFile);

export interface RenderInput {
  jobId: string;
  quote: string;
  textSafeArea: TextSafeArea;
  quoteRenderMode: QuoteRenderMode;
  durationSeconds: number;
  seed: number;
  brandHandle?: string | undefined;
  music: MusicSelection;
  /** Bytes of the licensed track, or undefined for a silent render. */
  musicBytes?: Uint8Array | undefined;
  image: { key: string; bytes: Uint8Array; source: StoredObject };
}

export interface RenderDependencies {
  store: ObjectStore;
  workDir: string;
  fontDir: string;
  fontOverride?: string | undefined;
  ffmpegBin?: string;
}

export interface RenderResult {
  manifest: RenderManifest;
  video: StoredObject;
  thumbnail: StoredObject;
  localVideoPath: string;
}

/**
 * Render one Reel.
 *
 * Every input that could change the output - image bytes, font file, music
 * licence reference, filter graph, ffmpeg build, seed - is recorded in the
 * manifest alongside the output checksum, so a published video can always be
 * traced back to exactly what produced it.
 */
export const renderReel = async (
  input: RenderInput,
  deps: RenderDependencies,
): Promise<RenderResult> => {
  const ffmpegBin = deps.ffmpegBin ?? resolveFfmpeg();
  // Verified before any work is done, so a build without drawtext fails with an
  // actionable message instead of an opaque filter-graph error.
  const capabilities = await assertRenderCapabilities(ffmpegBin);
  const workDir = join(deps.workDir, input.jobId);
  await mkdir(workDir, { recursive: true });

  const imagePath = join(workDir, 'source.png');
  const videoPath = join(workDir, 'reel.mp4');
  const thumbPath = join(workDir, 'cover.jpg');

  await writeFile(imagePath, input.image.bytes);

  let musicPath: string | undefined;
  if (input.music.mode === 'owned_licensed' && input.musicBytes) {
    musicPath = join(workDir, 'music.bin');
    await writeFile(musicPath, input.musicBytes);
  }

  const font = resolveFont({ fontDir: deps.fontDir, override: deps.fontOverride });

  const command = buildRenderCommand({
    imagePath,
    outputPath: videoPath,
    fontPath: font.file,
    quote: input.quote,
    textSafeArea: input.textSafeArea,
    durationSeconds: input.durationSeconds,
    seed: input.seed,
    musicPath,
    musicVolumeDb: input.music.volumeDb,
    brandHandle: input.brandHandle,
    workDir,
    // In embedded_ai mode the illustration already carries lettering, so the
    // renderer does not draw the quote a second time.
    drawQuote: input.quoteRenderMode !== 'embedded_ai',
  });

  await Promise.all(
    command.textFiles.map((file) => writeFile(file.path, file.content, 'utf8')),
  );

  try {
    await execFileAsync(ffmpegBin, command.args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new RetryableError('FFmpeg render failed', {
      cause: error,
      context: { jobId: input.jobId, stderr: (error as { stderr?: string }).stderr?.slice(0, 2_000) },
    });
  }

  await execFileAsync(ffmpegBin, buildThumbnailCommand(videoPath, thumbPath), {
    maxBuffer: 8 * 1024 * 1024,
  });

  const videoBytes = new Uint8Array(await readFile(videoPath));
  const thumbBytes = new Uint8Array(await readFile(thumbPath));

  const video = await deps.store.put({
    key: s3Keys.render(input.jobId),
    body: videoBytes,
    contentType: 'video/mp4',
    metadata: { jobid: input.jobId, seed: String(input.seed) },
  });
  const thumbnail = await deps.store.put({
    key: s3Keys.thumbnail(input.jobId),
    body: thumbBytes,
    contentType: 'image/jpeg',
    metadata: { jobid: input.jobId },
  });

  const manifest: RenderManifest = {
    jobId: input.jobId,
    renderedAt: new Date().toISOString(),
    seed: input.seed,
    quoteRenderMode: input.quoteRenderMode,
    durationSeconds: input.durationSeconds,
    width: RENDER_PROFILE.width,
    height: RENDER_PROFILE.height,
    fps: RENDER_PROFILE.fps,
    ffmpegVersion: capabilities.version,
    ffmpegArgs: command.args,
    filterGraph: command.filterGraph,
    font,
    music: input.music,
    inputs: [input.image.source],
    output: video,
    thumbnail,
    outputChecksumSha256: sha256Hex(videoBytes),
  };

  await deps.store.put({
    key: s3Keys.manifest(input.jobId),
    body: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    contentType: 'application/json',
  });

  return { manifest, video, thumbnail, localVideoPath: videoPath };
};

export const cleanupWorkDir = async (workDir: string, jobId: string): Promise<void> => {
  await rm(join(workDir, jobId), { recursive: true, force: true });
};
