import type { MusicSelection, ObjectStore } from '@mrp/shared';
import { ConfigurationError, parseS3Uri } from '@mrp/shared';

import type { MusicProvider } from '../types.js';

/**
 * Music resolution.
 *
 * Two modes only, and `silent` is the default:
 *
 *   silent          - the render gets a generated silent AAC track. Always legal.
 *   owned_licensed  - a track the operator owns or has licensed, stored in the
 *                     private assets bucket, with a licence reference recorded in
 *                     the render manifest.
 *
 * There is deliberately no third option. Meta's in-app music library cannot be
 * selected programmatically and its licences do not extend to files this system
 * would mix into an MP4 - see docs/music-rights.md.
 */
export interface ConfiguredMusicProviderOptions {
  mode: 'owned_licensed' | 'silent';
  s3Uri?: string | undefined;
  licenseReference?: string | undefined;
  volumeDb: number;
  /** Store used to fetch the track. Must be the private assets bucket. */
  store?: ObjectStore | undefined;
}

export class ConfiguredMusicProvider implements MusicProvider {
  public constructor(private readonly options: ConfiguredMusicProviderOptions) {}

  public async resolve(): Promise<MusicSelection> {
    if (this.options.mode === 'silent') {
      return { mode: 'silent', volumeDb: this.options.volumeDb };
    }

    if (!this.options.s3Uri) {
      throw new ConfigurationError('MUSIC_MODE=owned_licensed requires MUSIC_S3_URI.');
    }
    if (!this.options.licenseReference) {
      throw new ConfigurationError(
        'MUSIC_MODE=owned_licensed requires MUSIC_LICENSE_REFERENCE. "Royalty-free" alone is not acceptable evidence - see docs/music-rights.md.',
      );
    }

    return {
      mode: 'owned_licensed',
      s3Uri: this.options.s3Uri,
      licenseReference: this.options.licenseReference,
      volumeDb: this.options.volumeDb,
    };
  }

  public async fetch(selection: MusicSelection): Promise<Uint8Array | undefined> {
    if (selection.mode === 'silent' || !selection.s3Uri) return undefined;
    if (!this.options.store) {
      throw new ConfigurationError('A private object store is required to fetch licensed music.');
    }
    const { bucket, key } = parseS3Uri(selection.s3Uri);
    if (bucket !== this.options.store.bucket) {
      // Music must live in the bucket the renderer role is scoped to.
      throw new ConfigurationError(
        `MUSIC_S3_URI points at bucket "${bucket}" but the renderer is scoped to "${this.options.store.bucket}".`,
      );
    }
    return this.options.store.get(key);
  }
}

/** Always silent. Used by local dry runs so no licensing question can arise. */
export class SilentMusicProvider implements MusicProvider {
  public constructor(private readonly volumeDb = -18) {}

  public async resolve(): Promise<MusicSelection> {
    return { mode: 'silent', volumeDb: this.volumeDb };
  }

  public async fetch(): Promise<undefined> {
    return undefined;
  }
}
