import { NonRetryableError, RetryableError, type Platform } from '@mrp/shared';

import type {
  ContainerRequest,
  ContainerStatus,
  PublishOutcome,
  PublishQuota,
  RemoteMediaStatus,
  SocialPublisher,
} from '../types.js';
import type { GraphClient } from './graph-client.js';
import {
  instagramContainerStatus,
  instagramCreateContainer,
  instagramMediaPermalink,
  instagramPublish,
  instagramPublishingLimit,
  type GraphEndpointConfig,
} from './payloads.js';

/**
 * Instagram Reels publisher.
 *
 * Three explicit phases, each driven by its own Step Functions state so retries
 * and timeouts are visible:
 *   1. createContainer     - Meta starts fetching the signed video URL
 *   2. getContainerStatus  - polled from a bounded Wait/Choice loop
 *   3. publishContainer    - only after FINISHED
 *
 * Containers expire. An EXPIRED status is surfaced as a distinct value so the
 * workflow restarts from container creation rather than retrying a dead id.
 */

const STATUS_MAP: Record<string, RemoteMediaStatus> = {
  IN_PROGRESS: 'IN_PROGRESS',
  FINISHED: 'FINISHED',
  ERROR: 'ERROR',
  EXPIRED: 'EXPIRED',
  PUBLISHED: 'FINISHED',
};

export interface InstagramPublisherOptions {
  client: GraphClient;
  endpoint: GraphEndpointConfig;
  igUserId: string;
  shareToFeed: boolean;
}

export class InstagramPublisher implements SocialPublisher {
  public readonly platform: Platform = 'instagram';

  public readonly live = true;

  public constructor(private readonly options: InstagramPublisherOptions) {}

  public async checkQuota(): Promise<PublishQuota> {
    const response = await this.options.client.send<{
      data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
    }>(instagramPublishingLimit(this.options.endpoint, this.options.igUserId));

    const entry = response.body.data?.[0];
    const used = entry?.quota_usage ?? 0;
    const limit = entry?.config?.quota_total ?? 0;
    if (limit === 0) {
      // Treat an unreadable quota as unsupported rather than as unlimited.
      return { remaining: 0, limit: 0, supported: false };
    }
    return { remaining: Math.max(0, limit - used), limit, supported: true };
  }

  public async createContainer(
    request: ContainerRequest,
  ): Promise<{ containerId: string; detail: unknown }> {
    const response = await this.options.client.send<{ id?: string }>(
      instagramCreateContainer(this.options.endpoint, {
        igUserId: this.options.igUserId,
        videoUrl: request.videoUrl,
        caption: request.caption,
        shareToFeed: request.shareToFeed ?? this.options.shareToFeed,
        coverUrl: request.thumbnailUrl,
      }),
    );

    const containerId = response.body.id;
    if (!containerId) {
      throw new RetryableError('Instagram container creation returned no id', {
        context: { detail: response.body },
      });
    }
    return { containerId, detail: response.body };
  }

  public async getContainerStatus(containerId: string): Promise<ContainerStatus> {
    const response = await this.options.client.send<{ status_code?: string; status?: string }>(
      instagramContainerStatus(this.options.endpoint, containerId),
    );
    const raw = response.body.status_code ?? 'IN_PROGRESS';
    const status = STATUS_MAP[raw] ?? 'IN_PROGRESS';
    return {
      status,
      detail: response.body,
      errorMessage: status === 'ERROR' ? (response.body.status ?? 'Container reported ERROR') : undefined,
    };
  }

  public async publishContainer(
    containerId: string,
    _request: ContainerRequest,
  ): Promise<PublishOutcome> {
    const response = await this.options.client.send<{ id?: string }>(
      instagramPublish(this.options.endpoint, this.options.igUserId, containerId),
    );

    const mediaId = response.body.id;
    if (!mediaId) {
      // No media id means we cannot prove what was published; never retry blindly.
      throw new NonRetryableError('Instagram publish returned no media id', {
        context: { detail: response.body },
      });
    }

    let permalink: string | undefined;
    try {
      const permalinkResponse = await this.options.client.send<{ permalink?: string }>(
        instagramMediaPermalink(this.options.endpoint, mediaId),
      );
      permalink = permalinkResponse.body.permalink;
    } catch {
      // The post succeeded; a missing permalink is cosmetic.
      permalink = undefined;
    }

    return { platform: 'instagram', mediaId, permalink, detail: response.body };
  }
}
