import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { sha256Hex } from '../util/hash.js';
import type { StoredObject } from '../types.js';
import type { ObjectStore, PutObjectInput } from './index.js';

export interface S3ObjectStoreOptions {
  bucket: string;
  client?: S3Client;
  region?: string;
}

export class S3ObjectStore implements ObjectStore {
  public readonly bucket: string;

  private readonly client: S3Client;

  public constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client({ region: options.region });
  }

  public async put(input: PutObjectInput): Promise<StoredObject> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: input.metadata,
        // Bucket policy also enforces this; belt and braces.
        ServerSideEncryption: 'aws:kms',
      }),
    );
    return {
      bucket: this.bucket,
      key: input.key,
      etag: result.ETag?.replaceAll('"', ''),
      versionId: result.VersionId,
      sizeBytes: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
    };
  }

  public async get(key: string): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error(`Empty body for s3://${this.bucket}/${key}`);
    return new Uint8Array(await result.Body.transformToByteArray());
  }

  public async head(key: string): Promise<StoredObject | undefined> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        bucket: this.bucket,
        key,
        etag: result.ETag?.replaceAll('"', ''),
        versionId: result.VersionId,
        sizeBytes: result.ContentLength,
      };
    } catch (error) {
      if (error instanceof NotFound || (error as { name?: string }).name === 'NotFound') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Signed GET used only for Meta ingestion. TTL is configured to cover upload
   * plus bounded retries and no longer - see PRESIGNED_URL_TTL_SECONDS.
   */
  public async presignGet(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }
}
