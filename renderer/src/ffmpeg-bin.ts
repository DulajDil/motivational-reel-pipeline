import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { ConfigurationError } from '@mrp/shared';

const execFileAsync = promisify(execFile);

/**
 * FFmpeg binary resolution.
 *
 * Not every FFmpeg build has `drawtext`: it needs libfreetype (and, since 7.1,
 * libharfbuzz) compiled in, and several popular package-manager builds ship
 * without them. Since the quote overlay IS the product, a build without
 * `drawtext` is useless to us, and finding that out mid-render is too late.
 *
 * Resolution order:
 *   1. FFMPEG_PATH / FFPROBE_PATH   - explicit, used by the Lambda container
 *   2. the `ffmpeg-static` dev dependency, when installed
 *   3. `ffmpeg` / `ffprobe` on PATH
 */

const tryResolveStatic = (moduleName: string): string | undefined => {
  try {
    const require_ = createRequire(import.meta.url);
    const resolved = require_(moduleName) as unknown;
    return typeof resolved === 'string' ? resolved : undefined;
  } catch {
    return undefined;
  }
};

export const resolveFfmpeg = (): string =>
  process.env.FFMPEG_PATH ?? tryResolveStatic('ffmpeg-static') ?? 'ffmpeg';

export const resolveFfprobe = (): string => process.env.FFPROBE_PATH ?? 'ffprobe';

export interface FfmpegCapabilities {
  path: string;
  version: string;
  hasDrawtext: boolean;
}

export const inspectFfmpeg = async (bin = resolveFfmpeg()): Promise<FfmpegCapabilities> => {
  let version = 'unknown';
  let filters = '';
  try {
    const [versionResult, filtersResult] = await Promise.all([
      execFileAsync(bin, ['-hide_banner', '-version'], { maxBuffer: 1024 * 1024 }),
      execFileAsync(bin, ['-hide_banner', '-filters'], { maxBuffer: 8 * 1024 * 1024 }),
    ]);
    version = versionResult.stdout.split('\n')[0]?.trim() ?? 'unknown';
    filters = filtersResult.stdout;
  } catch (error) {
    throw new ConfigurationError(
      `Could not run FFmpeg at "${bin}". Install FFmpeg, or set FFMPEG_PATH.`,
      { cause: error },
    );
  }

  return { path: bin, version, hasDrawtext: /\bdrawtext\b/.test(filters) };
};

/**
 * Fail fast, with a fix, rather than emitting "Filter not found" from deep
 * inside a filter graph.
 */
export const assertRenderCapabilities = async (bin = resolveFfmpeg()): Promise<FfmpegCapabilities> => {
  const capabilities = await inspectFfmpeg(bin);
  if (!capabilities.hasDrawtext) {
    throw new ConfigurationError(
      [
        `The FFmpeg build at "${capabilities.path}" has no "drawtext" filter, so the quote cannot be drawn.`,
        'drawtext requires libfreetype (and libharfbuzz on FFmpeg 7.1+), which some package-manager builds omit.',
        '',
        'Fixes:',
        '  npm install            # installs the ffmpeg-static dev dependency, which includes drawtext',
        '  FFMPEG_PATH=/path/to/full/ffmpeg npm run render:local',
        '',
        `Detected build: ${capabilities.version}`,
      ].join('\n'),
    );
  }
  return capabilities;
};
