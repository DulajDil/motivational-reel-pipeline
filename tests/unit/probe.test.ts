import { describe, expect, it } from 'vitest';

import { profileFor, validateProbe } from '@mrp/renderer';

const goodProbe = {
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '14.000000',
    size: '9744268',
    bit_rate: '5568153',
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1080,
      height: 1920,
      avg_frame_rate: '30/1',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
};

describe('validateProbe', () => {
  const profile = profileFor('instagram');

  it('accepts a conforming render', () => {
    const report = validateProbe(goodProbe, profile);
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.width).toBe(1080);
    expect(report.fps).toBe(30);
  });

  it('rejects the wrong dimensions', () => {
    const report = validateProbe(
      { ...goodProbe, streams: [{ ...goodProbe.streams[0]!, width: 720, height: 1280 }, goodProbe.streams[1]!] },
      profile,
    );
    expect(report.passed).toBe(false);
    expect(report.failures).toContain('dimensions:720x1280');
  });

  it('rejects a missing audio track', () => {
    const report = validateProbe({ ...goodProbe, streams: [goodProbe.streams[0]!] }, profile);
    expect(report.failures).toContain('no_audio_stream');
  });

  it('rejects the wrong codecs', () => {
    const report = validateProbe(
      {
        ...goodProbe,
        streams: [
          { ...goodProbe.streams[0]!, codec_name: 'vp9' },
          { codec_type: 'audio', codec_name: 'opus' },
        ],
      },
      profile,
    );
    expect(report.failures).toContain('video_codec:vp9');
    expect(report.failures).toContain('audio_codec:opus');
  });

  it.each([
    ['4.000000', 'duration:4.00'],
    ['45.000000', 'duration:45.00'],
  ])('rejects out-of-range duration %s', (duration, expected) => {
    const report = validateProbe(
      { ...goodProbe, format: { ...goodProbe.format, duration } },
      profile,
    );
    expect(report.failures).toContain(expected);
  });

  it('rejects an empty file', () => {
    const report = validateProbe(
      { ...goodProbe, format: { ...goodProbe.format, size: '0' } },
      profile,
    );
    expect(report.failures).toContain('empty_file');
  });

  it('parses fractional frame rates', () => {
    const report = validateProbe(
      {
        ...goodProbe,
        streams: [{ ...goodProbe.streams[0]!, avg_frame_rate: '30000/1001' }, goodProbe.streams[1]!],
      },
      profile,
    );
    expect(report.fps).toBeCloseTo(29.97, 2);
    expect(report.passed).toBe(true);
  });
});
