import type { StoredObject } from '../types.js';

export interface PutObjectInput {
  key: string;
  body: Uint8Array;
  contentType: string;
  /** Small, non-sensitive descriptors only. S3 metadata is not encrypted separately. */
  metadata?: Record<string, string>;
}

/**
 * Storage port. `S3ObjectStore` in AWS, `FileSystemObjectStore` for local dev and
 * tests, so `npm run dry-run` needs no credentials and no LocalStack.
 */
export interface ObjectStore {
  readonly bucket: string;
  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<StoredObject | undefined>;
  /**
   * Short-lived signed HTTPS URL. Used only where Meta ingestion requires a
   * publicly fetchable URL; the bucket itself stays private.
   */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
}

/** S3 key layout. Prefixes double as the IAM boundary between roles. */
export const s3Keys = {
  rawImage: (jobId: string, attempt: number) => `raw/images/${jobId}/attempt-${attempt}.json`,
  image: (jobId: string, attempt: number) => `images/${jobId}/attempt-${attempt}.png`,
  render: (jobId: string) => `renders/${jobId}/reel.mp4`,
  thumbnail: (jobId: string) => `renders/${jobId}/cover.jpg`,
  manifest: (jobId: string) => `manifests/${jobId}/render-manifest.json`,
  publishReceipt: (jobId: string, platform: string) => `receipts/${jobId}/${platform}.json`,
} as const;

export const parseS3Uri = (uri: string): { bucket: string; key: string } => {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Not an s3:// URI: ${uri}`);
  }
  return { bucket: match[1], key: match[2] };
};

export * from './s3-store.js';
export * from './fs-store.js';
