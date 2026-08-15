import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { NonRetryableError, type VideoValidationReport } from '@mrp/shared';

import { buildProbeCommand } from './ffmpeg-args.js';
import { resolveFfprobe } from './ffmpeg-bin.js';
import type { VideoProfile } from './profiles.js';

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
}

const parseFrameRate = (value: string | undefined): number => {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/');
  const n = Number(numerator ?? 0);
  const d = Number(denominator ?? 1);
  return d === 0 ? 0 : n / d;
};

export const probeVideo = async (
  videoPath: string,
  ffprobeBin = resolveFfprobe(),
): Promise<FfprobeOutput> => {
  try {
    const { stdout } = await execFileAsync(ffprobeBin, buildProbeCommand(videoPath), {
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout) as FfprobeOutput;
  } catch (error) {
    throw new NonRetryableError('ffprobe could not read the rendered file', {
      cause: error,
      context: { videoPath },
    });
  }
};

/**
 * Verify the rendered file against a platform profile.
 *
 * This runs BEFORE anything is published. A failure here is terminal for the
 * render: the workflow will not fall through to a publish state.
 */
export const validateProbe = (probe: FfprobeOutput, profile: VideoProfile): VideoValidationReport => {
  const failures: string[] = [];
  const streams = probe.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  const container = probe.format?.format_name ?? 'unknown';
  const durationSeconds = Number(probe.format?.duration ?? video?.duration ?? 0);
  const sizeBytes = Number(probe.format?.size ?? 0);
  const bitrateBps = Number(probe.format?.bit_rate ?? video?.bit_rate ?? 0);
  const fps = parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate);

  if (!video) failures.push('no_video_stream');
  if (!profile.container.some((allowed) => container.includes(allowed))) {
    failures.push(`container:${container}`);
  }
  if (video && !profile.videoCodec.includes(video.codec_name ?? '')) {
    failures.push(`video_codec:${video.codec_name}`);
  }
  if (profile.requireAudioTrack && !audio) failures.push('no_audio_stream');
  if (audio && !profile.audioCodec.includes(audio.codec_name ?? '')) {
    failures.push(`audio_codec:${audio.codec_name}`);
  }
  if (video?.width !== profile.width || video?.height !== profile.height) {
    failures.push(`dimensions:${video?.width}x${video?.height}`);
  }
  if (durationSeconds < profile.minDurationSeconds || durationSeconds > profile.maxDurationSeconds) {
    failures.push(`duration:${durationSeconds.toFixed(2)}`);
  }
  if (fps < profile.minFps || fps > profile.maxFps) failures.push(`fps:${fps.toFixed(2)}`);
  if (bitrateBps > profile.maxBitrateBps) failures.push(`bitrate:${bitrateBps}`);
  if (sizeBytes > profile.maxSizeBytes) failures.push(`size:${sizeBytes}`);
  if (sizeBytes === 0) failures.push('empty_file');

  return {
    passed: failures.length === 0,
    container,
    videoCodec: video?.codec_name ?? 'none',
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    durationSeconds,
    fps,
    bitrateBps,
    sizeBytes,
    failures,
  };
};
