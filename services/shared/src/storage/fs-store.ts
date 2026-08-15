import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sha256Hex } from '../util/hash.js';
import type { StoredObject } from '../types.js';
import type { ObjectStore, PutObjectInput } from './index.js';

/**
 * Local filesystem object store.
 *
 * Used by unit tests, `npm run dry-run` and `npm run render:local` so the whole
 * pipeline can be exercised with no AWS credentials. `presignGet` returns a
 * `file://` URL, which is deliberately useless to Meta - a dry run must never be
 * able to hand a real ingestion URL to anything.
 */
export class FileSystemObjectStore implements ObjectStore {
  public readonly bucket: string;

  private readonly root: string;

  public constructor(root: string, bucket = 'local-bucket') {
    this.root = resolve(root);
    this.bucket = bucket;
  }

  public pathFor(key: string): string {
    return join(this.root, key);
  }

  public async put(input: PutObjectInput): Promise<StoredObject> {
    const target = this.pathFor(input.key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.body);
    return {
      bucket: this.bucket,
      key: input.key,
      etag: sha256Hex(input.body).slice(0, 32),
      sizeBytes: input.body.byteLength,
      checksumSha256: sha256Hex(input.body),
    };
  }

  public async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  public async head(key: string): Promise<StoredObject | undefined> {
    try {
      const stats = await stat(this.pathFor(key));
      return { bucket: this.bucket, key, sizeBytes: stats.size };
    } catch {
      return undefined;
    }
  }

  public async presignGet(key: string, _ttlSeconds: number): Promise<string> {
    return pathToFileURL(this.pathFor(key)).toString();
  }
}
