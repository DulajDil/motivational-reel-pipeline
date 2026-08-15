import { redactUrl, type Platform } from '@mrp/shared';

import type {
  ContainerRequest,
  ContainerStatus,
  PublishOutcome,
  PublishQuota,
  SocialPublisher,
} from '../types.js';
import { type GraphEndpointConfig } from './payloads.js';
import {
  facebookFinishUpload,
  facebookHostedUpload,
  facebookStartUpload,
  instagramCreateContainer,
  instagramPublish,
} from './payloads.js';

export interface RecordedCall {
  phase: 'create' | 'status' | 'publish';
  method: string;
  url: string;
  form?: Record<string, string> | undefined;
  headers?: Record<string, string> | undefined;
}

/**
 * No-op publisher used in dry_run mode and in local/dev.
 *
 * It builds the exact request each real publisher would send, records it for
 * inspection and assertion, and makes no network call whatsoever. `live` is
 * false, which is what the workflow checks before it will touch Meta at all.
 */
export class DryRunPublisher implements SocialPublisher {
  public readonly live = false;

  public readonly calls: RecordedCall[] = [];

  public constructor(
    public readonly platform: Platform,
    private readonly options: {
      endpoint: GraphEndpointConfig;
      accountId: string;
      shareToFeed?: boolean;
    },
  ) {}

  public async checkQuota(): Promise<PublishQuota> {
    return { remaining: Number.POSITIVE_INFINITY, limit: 0, supported: false };
  }

  public async createContainer(
    request: ContainerRequest,
  ): Promise<{ containerId: string; detail: unknown }> {
    const built =
      this.platform === 'instagram'
        ? instagramCreateContainer(this.options.endpoint, {
            igUserId: this.options.accountId,
            videoUrl: request.videoUrl,
            caption: request.caption,
            shareToFeed: request.shareToFeed ?? this.options.shareToFeed ?? true,
            coverUrl: request.thumbnailUrl,
          })
        : facebookStartUpload(this.options.endpoint, this.options.accountId);

    this.calls.push({
      phase: 'create',
      method: built.method,
      url: redactUrl(built.url),
      form: built.form,
    });

    if (this.platform === 'facebook') {
      const upload = facebookHostedUpload(this.options.endpoint, 'dryrun-video-id', request.videoUrl);
      this.calls.push({
        phase: 'create',
        method: upload.method,
        url: upload.url,
        headers: { file_url: redactUrl(request.videoUrl) },
      });
    }

    // Deterministic id so dry-run snapshots are stable.
    return {
      containerId: `dryrun-${this.platform}-${request.idempotencyKey.slice(0, 12)}`,
      detail: { dryRun: true, recorded: this.calls.length },
    };
  }

  public async getContainerStatus(_containerId: string): Promise<ContainerStatus> {
    this.calls.push({ phase: 'status', method: 'GET', url: '(dry-run, no call made)' });
    return { status: 'FINISHED', detail: { dryRun: true } };
  }

  public async publishContainer(
    containerId: string,
    request: ContainerRequest,
  ): Promise<PublishOutcome> {
    const built =
      this.platform === 'instagram'
        ? instagramPublish(this.options.endpoint, this.options.accountId, containerId)
        : facebookFinishUpload(
            this.options.endpoint,
            this.options.accountId,
            containerId,
            request.caption,
          );

    this.calls.push({
      phase: 'publish',
      method: built.method,
      url: redactUrl(built.url),
      form: built.form,
    });

    return {
      platform: this.platform,
      mediaId: `dryrun-media-${containerId}`,
      permalink: undefined,
      detail: { dryRun: true, wouldHaveCalled: built.url },
    };
  }
}
