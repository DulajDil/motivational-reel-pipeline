import type {
  ImageValidationReport,
  MusicSelection,
  Platform,
  QuoteRenderMode,
  TextSafeArea,
} from '@mrp/shared';

/**
 * Provider ports.
 *
 * Every external intelligence or publishing dependency sits behind one of these
 * interfaces so it can be swapped without touching the workflow. Each has a mock
 * implementation used by tests and `PROVIDER_MODE=mock`.
 */

export interface ProviderIdentity {
  /** e.g. "bedrock", "mock". Stored on the job for audit. */
  readonly provider: string;
  /** Resolved from configuration, never hardcoded. */
  readonly modelId: string;
  readonly promptVersion: string;
}

// ------------------------------------------------------------------ quotes

export interface QuoteRequest {
  jobId: string;
  /** Phrases from recent history the model is told to avoid. */
  avoidPhrases: string[];
  minWords: number;
  maxWords: number;
  seed: number;
}

export interface GeneratedQuote extends ProviderIdentity {
  text: string;
  /** One-line description of the illustration to draw. Contains no lettering. */
  sceneConcept: string;
  /** Why this line passes the content rules. Persisted for audit. */
  safetyRationale: string;
}

export interface QuoteGenerator {
  generate(request: QuoteRequest): Promise<GeneratedQuote>;
}

// ----------------------------------------------------------------- captions

export interface CaptionRequest {
  jobId: string;
  quote: string;
  sceneConcept: string;
  brandHandle?: string | undefined;
}

export interface GeneratedCaption extends ProviderIdentity {
  caption: string;
  altText: string;
  hashtags: string[];
}

export interface CaptionGenerator {
  generate(request: CaptionRequest): Promise<GeneratedCaption>;
}

// ------------------------------------------------------------------ images

export interface ImageRequest {
  jobId: string;
  sceneConcept: string;
  textSafeArea: TextSafeArea;
  quoteRenderMode: QuoteRenderMode;
  /** Only supplied in embedded_ai/hybrid mode; never used to drive spelling. */
  quote?: string | undefined;
  seed: number;
  width: number;
  height: number;
  attempt: number;
  /**
   * Approved brand reference frame, used as a style and composition guide so
   * every Reel reads as the same series. Loaded from REFERENCE_IMAGE_S3_URI.
   * Providers that cannot condition on an image must ignore it rather than
   * silently sending it as content.
   */
  referenceImage?: ReferenceImage | undefined;
}

export interface ReferenceImage {
  /** Raw bytes of the approved reference frame. */
  data: Uint8Array;
  format: 'png' | 'jpeg';
  /**
   * 0..1. How strongly the generated image should resemble the reference:
   * higher is more faithful to the style, lower gives the model more freedom.
   */
  similarityStrength: number;
}

export interface GeneratedImage extends ProviderIdentity {
  data: Uint8Array;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  /** Raw provider response, already redacted, persisted to private S3. */
  rawResponse: unknown;
  prompt: string;
  negativePrompt: string;
}

export interface ImageGenerator {
  generate(request: ImageRequest): Promise<GeneratedImage>;
}

// --------------------------------------------------------------- validation

export interface ImageValidationRequest {
  jobId: string;
  image: Pick<GeneratedImage, 'data' | 'format' | 'width' | 'height'>;
  textSafeArea: TextSafeArea;
  quoteRenderMode: QuoteRenderMode;
  expectedWidth: number;
  expectedHeight: number;
}

export interface ImageValidator {
  validate(request: ImageValidationRequest): Promise<ImageValidationReport>;
}

// -------------------------------------------------------------------- music

export interface MusicProvider {
  /**
   * Resolves the track to mix in. Returns a silent selection unless an owned or
   * licensed track with a licence reference is configured.
   */
  resolve(): Promise<MusicSelection>;
  /** Returns undefined for a silent render. */
  fetch(selection: MusicSelection): Promise<Uint8Array | undefined>;
}

// ---------------------------------------------------------------- publishing

export interface PublishQuota {
  /** Remaining publishes allowed by the platform in the current window. */
  remaining: number;
  limit: number;
  /** Undefined when the platform does not expose a quota endpoint. */
  supported: boolean;
}

export interface ContainerRequest {
  jobId: string;
  /** Short-lived signed HTTPS URL of the rendered MP4. */
  videoUrl: string;
  caption: string;
  thumbnailUrl?: string | undefined;
  shareToFeed?: boolean | undefined;
  idempotencyKey: string;
}

export type RemoteMediaStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED';

export interface ContainerStatus {
  status: RemoteMediaStatus;
  /** Redacted provider payload for the audit record. */
  detail: unknown;
  errorMessage?: string | undefined;
}

export interface PublishOutcome {
  platform: Platform;
  mediaId: string;
  permalink?: string | undefined;
  detail: unknown;
}

/**
 * Common publishing port. Instagram and Facebook are separate transactions and
 * each implementation owns its own multi-phase flow; the workflow drives the
 * phases explicitly so every step is retryable and observable.
 */
export interface SocialPublisher {
  readonly platform: Platform;
  /** True when this implementation will actually contact Meta. */
  readonly live: boolean;
  checkQuota(): Promise<PublishQuota>;
  /** Phase 1: create the container / start the upload session. */
  createContainer(request: ContainerRequest): Promise<{ containerId: string; detail: unknown }>;
  /** Phase 2: poll. Must be called from a bounded loop. */
  getContainerStatus(containerId: string): Promise<ContainerStatus>;
  /** Phase 3: publish. Must only be called after a FINISHED status. */
  publishContainer(containerId: string, request: ContainerRequest): Promise<PublishOutcome>;
}
