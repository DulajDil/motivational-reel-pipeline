import type { Platform, PublishMode, QuoteRenderMode } from './config/schema.js';

export type JobStatus =
  | 'CREATED'
  | 'QUOTE_READY'
  | 'IMAGE_READY'
  | 'RENDERED'
  | 'VIDEO_VALIDATED'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'FAILED'
  | 'MANUAL_REVIEW'
  | 'CANCELLED';

/** Terminal states. A job in one of these is never picked up by automation again. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
];

export type PublishStatus =
  | 'PENDING'
  | 'SKIPPED'
  | 'IN_PROGRESS'
  | 'AWAITING_APPROVAL'
  | 'PUBLISHED'
  | 'FAILED'
  | 'RETRYABLE';

/**
 * Region of the illustration deliberately left uncluttered by the image prompt so
 * the overlay renderer has somewhere legible to draw the quote.
 * Coordinates are normalised (0..1) against a 1080x1920 canvas.
 */
export interface TextSafeArea {
  position: 'upper_left' | 'upper_middle' | 'lower_left';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuoteRecord {
  text: string;
  fingerprint: string;
  wordCount: number;
  provider: string;
  modelId: string;
  promptVersion: string;
  createdAt: string;
  /** Why the content-safety checks passed. Stored for audit, never user-facing. */
  safetyRationale: string;
}

export interface ContentMetadata {
  quote: QuoteRecord;
  sceneConcept: string;
  caption: string;
  altText: string;
  hashtags: string[];
  textSafeArea: TextSafeArea;
}

export interface StoredObject {
  bucket: string;
  key: string;
  etag?: string | undefined;
  versionId?: string | undefined;
  sizeBytes?: number | undefined;
  checksumSha256?: string | undefined;
}

export interface ImageAsset extends StoredObject {
  width: number;
  height: number;
  format: 'png' | 'jpeg';
}

export interface ImageValidationReport {
  passed: boolean;
  width: number;
  height: number;
  format: string;
  /** 0..1, higher is more likely to be a near-duplicate of recent output. */
  maxSimilarity: number;
  /** Text detected by OCR anywhere in the frame. */
  detectedText: string[];
  /** Text detected specifically inside the reserved area - fatal in overlay mode. */
  detectedTextInSafeArea: string[];
  moderationLabels: string[];
  failures: string[];
}

export interface MusicSelection {
  mode: 'owned_licensed' | 'silent';
  s3Uri?: string | undefined;
  licenseReference?: string | undefined;
  volumeDb: number;
}

export interface RenderManifest {
  jobId: string;
  renderedAt: string;
  seed: number;
  quoteRenderMode: QuoteRenderMode;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  ffmpegVersion: string;
  ffmpegArgs: string[];
  filterGraph: string;
  font: { family: string; file: string; sha256: string; license: string };
  music: MusicSelection;
  inputs: StoredObject[];
  output: StoredObject;
  thumbnail: StoredObject;
  outputChecksumSha256: string;
}

export interface VideoValidationReport {
  passed: boolean;
  container: string;
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
  bitrateBps: number;
  sizeBytes: number;
  failures: string[];
}

/** Mirrors the provider-side container status without depending on that package. */
export type RemoteMediaStatusLike = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED';

export interface PlatformPublishState {
  platform: Platform;
  status: PublishStatus;
  idempotencyKey: string;
  attempts: number;
  /** Instagram only. */
  containerId?: string | undefined;
  /** Facebook only. */
  uploadSessionId?: string | undefined;
  mediaId?: string | undefined;
  permalink?: string | undefined;
  lastErrorCode?: string | undefined;
  lastErrorMessage?: string | undefined;
  firstAttemptAt?: string | undefined;
  lastAttemptAt?: string | undefined;
  publishedAt?: string | undefined;
}

export interface Job {
  jobId: string;
  idempotencyKey: string;
  status: JobStatus;
  /** Local calendar date of the intended publish. */
  publishDate: string;
  slot: number;
  configVersion: string;
  publishMode: PublishMode;
  createdAt: string;
  updatedAt: string;
  scheduledFor?: string | undefined;
  content?: ContentMetadata | undefined;
  image?: ImageAsset | undefined;
  imageValidation?: ImageValidationReport | undefined;
  render?: RenderManifest | undefined;
  videoValidation?: VideoValidationReport | undefined;
  platforms: Partial<Record<Platform, PlatformPublishState>>;
  generationAttempts: number;
  reviewReason?: string | undefined;
  failureReason?: string | undefined;
}

/** Append-only audit record. Written once, never updated. */
export interface JobEvent {
  jobId: string;
  sequence: number;
  at: string;
  type: string;
  actor: 'workflow' | 'scheduler' | 'admin' | 'system';
  /** Already redacted before it reaches this type. */
  detail: Record<string, unknown>;
}

export interface ReviewItem {
  jobId: string;
  reason: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  resolvedAt?: string | undefined;
  resolvedBy?: string | undefined;
  notes?: string | undefined;
}

export interface ScheduleEntry {
  jobId: string;
  platform: Platform;
  publishDate: string;
  publishAt: string;
  status: 'PENDING' | 'DISPATCHED' | 'CANCELLED';
}

/** Payload carried between Step Functions states. */
export interface WorkflowState {
  jobId: string;
  idempotencyKey: string;
  publishDate: string;
  slot: number;
  status: JobStatus;
  /** Set when CreateJob short-circuits on an already-completed job. */
  alreadyComplete?: boolean;
  generationAttempts?: number;
  pollAttempts?: number;
  platforms?: Platform[];
}
