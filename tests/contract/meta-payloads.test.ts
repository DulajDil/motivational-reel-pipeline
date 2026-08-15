import { describe, expect, it, vi } from 'vitest';

import { ConfigurationError, RetryableError, NonRetryableError } from '@mrp/shared';
import {
  GraphClient,
  InstagramPublisher,
  FacebookPublisher,
  classifyGraphError,
  facebookFinishUpload,
  facebookHostedUpload,
  facebookStartUpload,
  instagramContainerStatus,
  instagramCreateContainer,
  instagramPublish,
  instagramPublishingLimit,
} from '@mrp/providers';

const endpoint = { baseUrl: 'https://graph.facebook.com', version: 'v21.0' };

/**
 * Contract tests for the Meta layer.
 *
 * These pin the exact request shape and the error classification without ever
 * contacting Meta. `fetch` is injected, so nothing here can make a network call.
 */
describe('Graph request builders', () => {
  it('builds the Instagram Reels container request', () => {
    expect(
      instagramCreateContainer(endpoint, {
        igUserId: '17841400000000000',
        videoUrl: 'https://example.test/reel.mp4?sig=x',
        caption: 'a caption',
        shareToFeed: true,
        coverUrl: 'https://example.test/cover.jpg',
      }),
    ).toMatchSnapshot();
  });

  it('builds the status, publish and quota requests', () => {
    expect(instagramContainerStatus(endpoint, '123')).toMatchSnapshot();
    expect(instagramPublish(endpoint, '17841400000000000', '123')).toMatchSnapshot();
    expect(instagramPublishingLimit(endpoint, '17841400000000000')).toMatchSnapshot();
  });

  it('builds the Facebook Reels upload-session requests', () => {
    expect(facebookStartUpload(endpoint, '9876543210')).toMatchSnapshot();
    expect(facebookHostedUpload(endpoint, 'v1', 'https://example.test/reel.mp4')).toMatchSnapshot();
    expect(facebookFinishUpload(endpoint, '9876543210', 'v1', 'a caption')).toMatchSnapshot();
  });

  it('never puts an access token in a request', () => {
    const built = [
      instagramCreateContainer(endpoint, {
        igUserId: '1',
        videoUrl: 'https://x.test/a.mp4',
        caption: 'c',
        shareToFeed: true,
      }),
      instagramPublish(endpoint, '1', '2'),
      facebookStartUpload(endpoint, '3'),
      facebookFinishUpload(endpoint, '3', '4', 'c'),
    ];
    for (const request of built) {
      const serialised = JSON.stringify(request).toLowerCase();
      expect(serialised).not.toContain('access_token');
      expect(serialised).not.toContain('bearer');
    }
  });

  it('uploads Facebook bytes against the rupload host, not the graph host', () => {
    expect(facebookHostedUpload(endpoint, 'v1', 'https://x.test/a.mp4').url).toContain(
      'rupload.facebook.com',
    );
  });
});

describe('classifyGraphError', () => {
  it.each([
    [190, 400, ConfigurationError],
    [200, 400, ConfigurationError],
    [4, 400, RetryableError],
    [32, 400, RetryableError],
    [100, 400, NonRetryableError],
  ])('maps code %i / HTTP %i', (code, status, expected) => {
    expect(classifyGraphError(status, { code, message: 'm' })).toBeInstanceOf(expected);
  });

  it('treats 429 and 5xx as retryable', () => {
    expect(classifyGraphError(429, {})).toBeInstanceOf(RetryableError);
    expect(classifyGraphError(503, {})).toBeInstanceOf(RetryableError);
  });
});

describe('GraphClient transport', () => {
  const okResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('sends the token as a header, never in the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ id: 'container-1' }));
    const client = new GraphClient({ accessToken: 'EAAtoken-value', fetchImpl });

    const publisher = new InstagramPublisher({
      client,
      endpoint,
      igUserId: '1784100',
      shareToFeed: true,
    });
    await publisher.createContainer({
      jobId: 'j',
      videoUrl: 'https://x.test/a.mp4',
      caption: 'c',
      idempotencyKey: 'k',
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).not.toContain('EAAtoken-value');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer EAAtoken-value',
    });
  });

  it('adds appsecret_proof when an app secret is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ id: 'c' }));
    const client = new GraphClient({
      accessToken: 'token-value-1234567890',
      appSecret: 'app-secret',
      fetchImpl,
    });
    await new InstagramPublisher({ client, endpoint, igUserId: '1', shareToFeed: true }).createContainer(
      { jobId: 'j', videoUrl: 'https://x.test/a.mp4', caption: 'c', idempotencyKey: 'k' },
    );
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).body).toContain('appsecret_proof=');
  });

  it('redacts tokens out of the returned payload', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse({ id: 'c', access_token: 'EAAsomethingsecret1234567890' }));
    const client = new GraphClient({ accessToken: 't-1234567890', fetchImpl });
    const result = await client.send({ method: 'GET', url: 'https://graph.facebook.com/v21.0/me' });
    expect(JSON.stringify(result.body)).not.toContain('EAAsomethingsecret');
  });
});

describe('publisher phase behaviour', () => {
  it('maps Instagram container statuses, including EXPIRED', async () => {
    const statuses = ['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED'];
    const fetchImpl = vi.fn();
    for (const status_code of statuses) {
      fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify({ status_code }), { status: 200 }),
      );
    }
    const publisher = new InstagramPublisher({
      client: new GraphClient({ accessToken: 't-1234567890', fetchImpl }),
      endpoint,
      igUserId: '1',
      shareToFeed: true,
    });

    const observed = [];
    for (let index = 0; index < statuses.length; index += 1) {
      observed.push((await publisher.getContainerStatus('c')).status);
    }
    expect(observed).toEqual(['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED']);
  });

  it('refuses to report success when Instagram returns no media id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const publisher = new InstagramPublisher({
      client: new GraphClient({ accessToken: 't-1234567890', fetchImpl }),
      endpoint,
      igUserId: '1',
      shareToFeed: true,
    });
    await expect(
      publisher.publishContainer('c', {
        jobId: 'j',
        videoUrl: '',
        caption: 'c',
        idempotencyKey: 'k',
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('reports the Instagram quota as unsupported rather than unlimited when unreadable', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const quota = await new InstagramPublisher({
      client: new GraphClient({ accessToken: 't-1234567890', fetchImpl }),
      endpoint,
      igUserId: '1',
      shareToFeed: true,
    }).checkQuota();
    expect(quota).toEqual({ remaining: 0, limit: 0, supported: false });
  });

  it('opens a Facebook upload session and hands over the file URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ video_id: 'v1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    const result = await new FacebookPublisher({
      client: new GraphClient({ accessToken: 't-1234567890', fetchImpl }),
      endpoint,
      pageId: '9',
    }).createContainer({
      jobId: 'j',
      videoUrl: 'https://x.test/a.mp4',
      caption: 'c',
      idempotencyKey: 'k',
    });

    expect(result.containerId).toBe('v1');
    expect(fetchImpl.mock.calls[1]![0]).toContain('rupload.facebook.com');
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      file_url: 'https://x.test/a.mp4',
    });
  });
});
