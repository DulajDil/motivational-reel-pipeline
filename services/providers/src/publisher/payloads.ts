/**
 * Meta Graph request builders.
 *
 * These are pure functions returning a method, URL and body. Crucially they
 * NEVER include the access token: the client injects it as an `Authorization`
 * header. That keeps tokens out of URLs, out of logs, out of snapshots and out
 * of any persisted receipt.
 *
 * IMPORTANT: endpoint paths, field names, required permissions and Reel
 * specifications change between Graph API versions. Every value here is
 * configuration-driven and MUST be verified against official Meta documentation
 * during onboarding and before each production release - see docs/meta-onboarding.md.
 */

export interface GraphEndpointConfig {
  baseUrl: string;
  version: string;
}

export interface GraphRequest {
  method: 'GET' | 'POST';
  url: string;
  /** Sent as application/x-www-form-urlencoded when present. */
  form?: Record<string, string>;
  /** Extra headers, excluding Authorization which the client adds. */
  headers?: Record<string, string>;
}

const graphUrl = (
  { baseUrl, version }: GraphEndpointConfig,
  path: string,
  query: Record<string, string> = {},
): string => {
  const url = new URL(`/${version}/${path.replace(/^\//, '')}`, baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
};

// ------------------------------------------------------------------ Instagram

export interface InstagramContainerInput {
  igUserId: string;
  videoUrl: string;
  caption: string;
  shareToFeed: boolean;
  coverUrl?: string | undefined;
}

/**
 * Phase 1 - create a Reels container. Meta fetches the video from `video_url`,
 * which is why the renderer's output needs a short-lived signed HTTPS URL.
 */
export const instagramCreateContainer = (
  endpoint: GraphEndpointConfig,
  input: InstagramContainerInput,
): GraphRequest => ({
  method: 'POST',
  url: graphUrl(endpoint, `${input.igUserId}/media`),
  form: {
    media_type: 'REELS',
    video_url: input.videoUrl,
    caption: input.caption,
    share_to_feed: String(input.shareToFeed),
    ...(input.coverUrl ? { cover_url: input.coverUrl } : {}),
  },
});

/** Phase 2 - poll. `status_code` is one of IN_PROGRESS | FINISHED | ERROR | EXPIRED. */
export const instagramContainerStatus = (
  endpoint: GraphEndpointConfig,
  containerId: string,
): GraphRequest => ({
  method: 'GET',
  url: graphUrl(endpoint, containerId, { fields: 'status_code,status' }),
});

/** Phase 3 - publish. Only valid once the container reports FINISHED. */
export const instagramPublish = (
  endpoint: GraphEndpointConfig,
  igUserId: string,
  containerId: string,
): GraphRequest => ({
  method: 'POST',
  url: graphUrl(endpoint, `${igUserId}/media_publish`),
  form: { creation_id: containerId },
});

/** Remaining publishes in Instagram's rolling window. Checked before each container. */
export const instagramPublishingLimit = (
  endpoint: GraphEndpointConfig,
  igUserId: string,
): GraphRequest => ({
  method: 'GET',
  url: graphUrl(endpoint, `${igUserId}/content_publishing_limit`, {
    fields: 'config,quota_usage',
  }),
});

export const instagramMediaPermalink = (
  endpoint: GraphEndpointConfig,
  mediaId: string,
): GraphRequest => ({
  method: 'GET',
  url: graphUrl(endpoint, mediaId, { fields: 'permalink' }),
});

// ------------------------------------------------------------------- Facebook

/** Phase 1 - open an upload session and reserve a video id. */
export const facebookStartUpload = (
  endpoint: GraphEndpointConfig,
  pageId: string,
): GraphRequest => ({
  method: 'POST',
  url: graphUrl(endpoint, `${pageId}/video_reels`),
  form: { upload_phase: 'start' },
});

/**
 * Phase 2 - hosted upload. The bytes are pulled by Meta from `file_url`, passed
 * as a header rather than a body, against the rupload host (not graph).
 */
export const facebookHostedUpload = (
  endpoint: GraphEndpointConfig,
  videoId: string,
  fileUrl: string,
): GraphRequest => ({
  method: 'POST',
  url: `https://rupload.facebook.com/video-upload/${endpoint.version}/${videoId}`,
  headers: { file_url: fileUrl },
});

/** Phase 2b - poll processing status before finishing. */
export const facebookUploadStatus = (
  endpoint: GraphEndpointConfig,
  videoId: string,
): GraphRequest => ({
  method: 'GET',
  url: graphUrl(endpoint, videoId, { fields: 'status' }),
});

/** Phase 3 - publish the Reel. */
export const facebookFinishUpload = (
  endpoint: GraphEndpointConfig,
  pageId: string,
  videoId: string,
  description: string,
): GraphRequest => ({
  method: 'POST',
  url: graphUrl(endpoint, `${pageId}/video_reels`, {}),
  form: {
    upload_phase: 'finish',
    video_id: videoId,
    video_state: 'PUBLISHED',
    description,
  },
});

export const facebookPermalink = (
  endpoint: GraphEndpointConfig,
  videoId: string,
): GraphRequest => ({
  method: 'GET',
  url: graphUrl(endpoint, videoId, { fields: 'permalink_url' }),
});
