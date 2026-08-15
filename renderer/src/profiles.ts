import type { Platform } from '@mrp/shared';

/**
 * Platform output constraints.
 *
 * These are CONSERVATIVE defaults chosen to sit comfortably inside what both
 * platforms accept. They are configuration, not truth.
 *
 * !! Meta's published Reel specifications, supported codecs, duration limits and
 * !! Graph API versions change. Verify these values against official Meta
 * !! documentation during onboarding and before every production release.
 * !! See docs/meta-onboarding.md.
 */

export interface VideoProfile {
  container: string[];
  videoCodec: string[];
  audioCodec: string[];
  requireAudioTrack: boolean;
  width: number;
  height: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  minFps: number;
  maxFps: number;
  maxBitrateBps: number;
  maxSizeBytes: number;
}

/** What this pipeline always produces. */
export const RENDER_PROFILE = {
  width: 1080,
  height: 1920,
  fps: 30,
  videoBitrate: '6M',
  maxrate: '8M',
  bufsize: '12M',
  audioBitrate: '128k',
  audioSampleRate: 48_000,
  audioChannels: 2,
  fadeSeconds: 0.6,
  gopSeconds: 2,
} as const;

const BASE: VideoProfile = {
  container: ['mov,mp4,m4a,3gp,3g2,mj2', 'mp4'],
  videoCodec: ['h264'],
  audioCodec: ['aac'],
  requireAudioTrack: true,
  width: RENDER_PROFILE.width,
  height: RENDER_PROFILE.height,
  // Our own creative bound (10-18s) sits inside the platform bound.
  minDurationSeconds: 9.5,
  maxDurationSeconds: 18.5,
  minFps: 24,
  maxFps: 60,
  maxBitrateBps: 20_000_000,
  maxSizeBytes: 250 * 1024 * 1024,
};

export const PLATFORM_PROFILES: Record<Platform, VideoProfile> = {
  instagram: { ...BASE },
  facebook: { ...BASE },
};

export const profileFor = (platform: Platform): VideoProfile => PLATFORM_PROFILES[platform];
