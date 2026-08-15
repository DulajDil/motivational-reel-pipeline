import { mulberry32 } from '@mrp/shared';
import type { TextSafeArea } from '@mrp/shared';

import { RENDER_PROFILE } from './profiles.js';
import { layoutQuote, type QuoteLayout } from './text-layout.js';

/**
 * FFmpeg command construction.
 *
 * Pure functions: given the same inputs they always produce the same argv, which
 * is what makes renders reproducible and the command snapshot-testable. Nothing
 * here touches the filesystem or spawns a process.
 */

/** drawtext option values need `\ : '` escaped. */
export const escapeFilterValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

export interface KenBurns {
  zoomStart: number;
  zoomEnd: number;
  /** -1..1 horizontal drift, -1..1 vertical drift. */
  panX: number;
  panY: number;
}

/**
 * Motion derived entirely from the job seed: gentle, never flashy, and identical
 * on every re-render of the same job.
 */
export const kenBurnsFromSeed = (seed: number): KenBurns => {
  const random = mulberry32(seed);
  const zoomIn = random() > 0.5;
  const amplitude = 0.06 + random() * 0.05; // 6-11% zoom travel
  return {
    zoomStart: zoomIn ? 1.0 : 1 + amplitude,
    zoomEnd: zoomIn ? 1 + amplitude : 1.0,
    panX: (random() - 0.5) * 0.8,
    panY: (random() - 0.5) * 0.8,
  };
};

export interface TextFile {
  path: string;
  content: string;
}

export interface BuildRenderCommandInput {
  imagePath: string;
  outputPath: string;
  /** Absolute path to the bundled handwritten font. */
  fontPath: string;
  quote: string;
  textSafeArea: TextSafeArea;
  durationSeconds: number;
  seed: number;
  /** Undefined renders a silent AAC track. */
  musicPath?: string | undefined;
  musicVolumeDb?: number | undefined;
  brandHandle?: string | undefined;
  /** Directory the wrapped quote lines are written into. */
  workDir: string;
  /** In embedded_ai mode the illustration already carries the lettering. */
  drawQuote?: boolean;
}

export interface RenderCommand {
  args: string[];
  filterGraph: string;
  layout: QuoteLayout;
  kenBurns: KenBurns;
  /** Files the caller must write before spawning ffmpeg. */
  textFiles: TextFile[];
}

const INK_COLOUR = '0x2A221C';
const HANDLE_COLOUR = '0x6B5C4C';

export const buildRenderCommand = (input: BuildRenderCommandInput): RenderCommand => {
  const { width, height, fps } = RENDER_PROFILE;
  const duration = input.durationSeconds;
  const frames = Math.round(duration * fps);
  const kenBurns = kenBurnsFromSeed(input.seed);

  const layout = layoutQuote({
    text: input.quote,
    area: input.textSafeArea,
    canvasWidth: width,
    canvasHeight: height,
  });

  const textFiles: TextFile[] = [];
  const drawQuote = input.drawQuote !== false;

  // Pre-upscale before zoompan: zoompan works on integer offsets, so a larger
  // source removes most of the visible stepping in the pan. 1.5x is the point
  // where extra source resolution stops buying visible smoothness and starts
  // costing real render time.
  const sourceWidth = Math.round(width * 1.5);
  const sourceHeight = Math.round(height * 1.5);
  const stages: string[] = [
    `[0:v]scale=${sourceWidth}:${sourceHeight}:force_original_aspect_ratio=increase`,
    `crop=${sourceWidth}:${sourceHeight}`,
    `zoompan=z='${kenBurns.zoomStart}+(${(kenBurns.zoomEnd - kenBurns.zoomStart).toFixed(4)})*on/${frames}'` +
      `:x='(iw-iw/zoom)/2+(${kenBurns.panX.toFixed(4)})*(iw-iw/zoom)/2*on/${frames}'` +
      `:y='(ih-ih/zoom)/2+(${kenBurns.panY.toFixed(4)})*(ih-ih/zoom)/2*on/${frames}'` +
      `:d=${frames}:s=${width}x${height}:fps=${fps}`,
    'setsar=1',
    'format=yuv420p',
  ];

  if (drawQuote) {
    layout.lines.forEach((line, index) => {
      const textPath = `${input.workDir}/quote-line-${index}.txt`;
      textFiles.push({ path: textPath, content: line });
      const y = layout.y + index * (layout.fontSize + layout.lineSpacing);
      stages.push(
        [
          'drawtext=' + `fontfile='${escapeFilterValue(input.fontPath)}'`,
          `textfile='${escapeFilterValue(textPath)}'`,
          `x=${layout.x}`,
          `y=${y}`,
          `fontsize=${layout.fontSize}`,
          `fontcolor=${INK_COLOUR}`,
          // A whisper of shadow keeps the ink legible over paper grain.
          'shadowcolor=0xD8C9AE@0.55',
          'shadowx=2',
          'shadowy=2',
        ].join(':'),
      );
    });
  }

  if (input.brandHandle) {
    const handlePath = `${input.workDir}/brand-handle.txt`;
    textFiles.push({ path: handlePath, content: input.brandHandle });
    stages.push(
      [
        'drawtext=' + `fontfile='${escapeFilterValue(input.fontPath)}'`,
        `textfile='${escapeFilterValue(handlePath)}'`,
        'x=(w-text_w)/2',
        `y=${height - 130}`,
        'fontsize=38',
        `fontcolor=${HANDLE_COLOUR}`,
        'alpha=0.85',
      ].join(':'),
    );
  }

  const fade = RENDER_PROFILE.fadeSeconds;
  stages.push(`fade=t=in:st=0:d=${fade}`);
  stages.push(`fade=t=out:st=${(duration - fade).toFixed(2)}:d=${fade}`);

  const videoChain = `${stages.join(',')}[v]`;

  const audioChain = input.musicPath
    ? `[1:a]volume=${input.musicVolumeDb ?? -18}dB,` +
      `afade=t=in:st=0:d=1.0,afade=t=out:st=${(duration - 1.5).toFixed(2)}:d=1.5,` +
      `atrim=0:${duration},asetpts=N/SR/TB,aformat=sample_fmts=fltp:sample_rates=${RENDER_PROFILE.audioSampleRate}:channel_layouts=stereo[a]`
    : `[1:a]atrim=0:${duration},asetpts=N/SR/TB[a]`;

  const filterGraph = `${videoChain};${audioChain}`;

  const args: string[] = [
    '-y',
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    // Input 0 is a SINGLE still frame. zoompan generates all `frames` output
    // frames from it. Looping the input here instead would make zoompan emit
    // `d` frames per input frame - frames squared - and the render would never
    // realistically finish.
    '-i',
    input.imagePath,
  ];

  if (input.musicPath) {
    args.push('-i', input.musicPath);
  } else {
    // Silent, but still a real AAC track: both platforms expect an audio stream.
    args.push(
      '-f',
      'lavfi',
      '-t',
      String(duration),
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${RENDER_PROFILE.audioSampleRate}`,
    );
  }

  args.push(
    '-filter_complex',
    filterGraph,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level',
    '4.0',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-g',
    String(fps * RENDER_PROFILE.gopSeconds),
    '-b:v',
    RENDER_PROFILE.videoBitrate,
    '-maxrate',
    RENDER_PROFILE.maxrate,
    '-bufsize',
    RENDER_PROFILE.bufsize,
    '-c:a',
    'aac',
    '-b:a',
    RENDER_PROFILE.audioBitrate,
    '-ar',
    String(RENDER_PROFILE.audioSampleRate),
    '-ac',
    String(RENDER_PROFILE.audioChannels),
    '-movflags',
    '+faststart',
    '-t',
    String(duration),
    input.outputPath,
  );

  return { args, filterGraph, layout, kenBurns, textFiles };
};

/** Cover image pulled from the rendered video so it always matches the output. */
export const buildThumbnailCommand = (videoPath: string, outputPath: string): string[] => [
  '-y',
  '-hide_banner',
  '-nostdin',
  '-loglevel',
  'error',
  '-ss',
  '1.5',
  '-i',
  videoPath,
  '-frames:v',
  '1',
  '-q:v',
  '3',
  outputPath,
];

export const buildProbeCommand = (videoPath: string): string[] => [
  '-v',
  'error',
  '-print_format',
  'json',
  '-show_format',
  '-show_streams',
  videoPath,
];
