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
  facebookFinishUpload,
  facebookHostedUpload,
  facebookPermalink,
  facebookStartUpload,
  facebookUploadStatus,
  type GraphEndpointConfig,
} from './payloads.js';

/**
 * Facebook Page Reels publisher.
 *
 * Mapped onto the same three-phase port as Instagram so the workflow can drive
 * both identically, but the underlying flow is different and the two are
 * separate publication transactions: publishing to one never publishes to the
 * other, and cross-posting is not assumed.
 *
 *   createContainer    - start the upload session, then hand Meta the file URL
 *   getContainerStatus - poll the video's processing status
 *   publishContainer   - finish the session with video_state=PUBLISHED
 */

export interface FacebookPublisherOptions {
  client: GraphClient;
  endpoint: GraphEndpointConfig;
  pageId: string;
}

const mapStatus = (payload: {
  status?: { video_status?: string; uploading_phase?: { status?: string }; processing_phase?: { status?: string } };
}): RemoteMediaStatus => {
  const status = payload.status;
  const video = status?.video_status?.toLowerCase();
  if (video === 'ready' || video === 'published') return 'FINISHED';
  if (video === 'error') return 'ERROR';
  if (video === 'expired') return 'EXPIRED';

  const processing = status?.processing_phase?.status?.toLowerCase();
  if (processing === 'complete') return 'FINISHED';
  if (processing === 'error') return 'ERROR';

  const uploading = status?.uploading_phase?.status?.toLowerCase();
  if (uploading === 'error') return 'ERROR';

  return 'IN_PROGRESS';
};

export class FacebookPublisher implements SocialPublisher {
  public readonly platform: Platform = 'facebook';

  public readonly live = true;

  public constructor(private readonly options: FacebookPublisherOptions) {}

  public async checkQuota(): Promise<PublishQuota> {
    // The Page Reels API does not expose a publishing-quota endpoint equivalent
    // to Instagram's. The pipeline's own daily cap is the control here.
    return { remaining: Number.POSITIVE_INFINITY, limit: 0, supported: false };
  }

  public async createContainer(
    request: ContainerRequest,
  ): Promise<{ containerId: string; detail: unknown }> {
    const start = await this.options.client.send<{ video_id?: string; upload_url?: string }>(
      facebookStartUpload(this.options.endpoint, this.options.pageId),
    );

    const videoId = start.body.video_id;
    if (!videoId) {
      throw new RetryableError('Facebook upload session returned no video_id', {
        context: { detail: start.body },
      });
    }

    // Hosted upload: Meta pulls the bytes from the short-lived signed URL.
    const upload = await this.options.client.send(
      facebookHostedUpload(this.options.endpoint, videoId, request.videoUrl),
    );

    return { containerId: videoId, detail: { start: start.body, upload: upload.body } };
  }

  public async getContainerStatus(containerId: string): Promise<ContainerStatus> {
    const response = await this.options.client.send<Parameters<typeof mapStatus>[0]>(
      facebookUploadStatus(this.options.endpoint, containerId),
    );
    const status = mapStatus(response.body);
    return {
      status,
      detail: response.body,
      errorMessage: status === 'ERROR' ? 'Facebook reported an upload/processing error' : undefined,
    };
  }

  public async publishContainer(
    containerId: string,
    request: ContainerRequest,
  ): Promise<PublishOutcome> {
    const response = await this.options.client.send<{ success?: boolean; post_id?: string }>(
      facebookFinishUpload(
        this.options.endpoint,
        this.options.pageId,
        containerId,
        request.caption,
      ),
    );

    if (response.body.success === false) {
      throw new NonRetryableError('Facebook refused to finish the Reel upload', {
        context: { detail: response.body },
      });
    }

    let permalink: string | undefined;
    try {
      const permalinkResponse = await this.options.client.send<{ permalink_url?: string }>(
        facebookPermalink(this.options.endpoint, containerId),
      );
      permalink = permalinkResponse.body.permalink_url;
    } catch {
      permalink = undefined;
    }

    return {
      platform: 'facebook',
      mediaId: response.body.post_id ?? containerId,
      permalink,
      detail: response.body,
    };
  }
}
