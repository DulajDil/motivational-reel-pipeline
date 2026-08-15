import { describe, expect, it } from 'vitest';

import {
  BRAND_TEXT_SAFE_AREA,
  LocalImageValidator,
  decodePng,
  encodePng,
  readImageDimensions,
  renderProceduralSketch,
} from '@mrp/providers';

describe('png codec', () => {
  it('round-trips pixel data', () => {
    const rgb = new Uint8Array(4 * 3 * 3);
    for (let index = 0; index < rgb.length; index += 1) rgb[index] = (index * 7) % 256;

    const png = encodePng(4, 3, rgb);
    const decoded = decodePng(png);

    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    expect([...decoded.rgb]).toEqual([...rgb]);
  });

  it('produces a chunk stream that walks cleanly to IEND', () => {
    const png = encodePng(2, 2, new Uint8Array(12));
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

    const seen: string[] = [];
    let offset = 8;
    while (offset + 8 <= png.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
      seen.push(type);
      offset += 12 + length;
      if (type === 'IEND') break;
    }

    expect(seen).toEqual(['IHDR', 'IDAT', 'IEND']);
    // Walking the chunks must land exactly on the end of the file.
    expect(offset).toBe(png.length);
  });

  it('reads dimensions without decoding', () => {
    expect(readImageDimensions(encodePng(8, 5, new Uint8Array(8 * 5 * 3)))).toEqual({
      width: 8,
      height: 5,
      format: 'png',
    });
  });

  it('rejects an unknown format', () => {
    expect(() => readImageDimensions(new Uint8Array([1, 2, 3, 4]))).toThrow(/Unsupported/);
  });
});

describe('procedural sketch', () => {
  it('is deterministic for a seed', () => {
    const options = {
      width: 120,
      height: 200,
      seed: 42,
      textSafeArea: BRAND_TEXT_SAFE_AREA,
    };
    expect([...renderProceduralSketch(options)]).toEqual([...renderProceduralSketch(options)]);
  });

  it('passes the offline validator at the expected size', async () => {
    const data = renderProceduralSketch({
      width: 1080,
      height: 1920,
      seed: 7,
      textSafeArea: BRAND_TEXT_SAFE_AREA,
    });

    const report = await new LocalImageValidator().validate({
      jobId: 'test',
      image: { data, format: 'png', width: 1080, height: 1920 },
      textSafeArea: BRAND_TEXT_SAFE_AREA,
      quoteRenderMode: 'overlay',
      expectedWidth: 1080,
      expectedHeight: 1920,
    });

    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('is rejected at the wrong size', async () => {
    const data = renderProceduralSketch({
      width: 540,
      height: 960,
      seed: 7,
      textSafeArea: BRAND_TEXT_SAFE_AREA,
    });

    const report = await new LocalImageValidator().validate({
      jobId: 'test',
      image: { data, format: 'png', width: 540, height: 960 },
      textSafeArea: BRAND_TEXT_SAFE_AREA,
      quoteRenderMode: 'overlay',
      expectedWidth: 1080,
      expectedHeight: 1920,
    });

    expect(report.passed).toBe(false);
    expect(report.failures[0]).toContain('wrong_dimensions');
  });

  it('rejects a blank frame as low contrast', async () => {
    const blank = encodePng(1080, 1920, new Uint8Array(1080 * 1920 * 3).fill(240));

    const report = await new LocalImageValidator().validate({
      jobId: 'test',
      image: { data: blank, format: 'png', width: 1080, height: 1920 },
      textSafeArea: BRAND_TEXT_SAFE_AREA,
      quoteRenderMode: 'overlay',
      expectedWidth: 1080,
      expectedHeight: 1920,
    });

    expect(report.passed).toBe(false);
    expect(report.failures.some((failure) => failure.startsWith('low_contrast'))).toBe(true);
  });

  it('rejects heavy ink inside the reserved text area', async () => {
    const area = BRAND_TEXT_SAFE_AREA;
    const rgb = new Uint8Array(1080 * 1920 * 3).fill(240);

    // Scribble dark pixels across the reserved area, as stray lettering would.
    for (let y = Math.floor(area.y * 1920); y < (area.y + area.height) * 1920; y += 2) {
      for (let x = Math.floor(area.x * 1080); x < (area.x + area.width) * 1080; x += 2) {
        const offset = (y * 1080 + x) * 3;
        rgb[offset] = 10;
        rgb[offset + 1] = 10;
        rgb[offset + 2] = 10;
      }
    }

    const report = await new LocalImageValidator().validate({
      jobId: 'test',
      image: { data: encodePng(1080, 1920, rgb), format: 'png', width: 1080, height: 1920 },
      textSafeArea: area,
      quoteRenderMode: 'overlay',
      expectedWidth: 1080,
      expectedHeight: 1920,
    });

    expect(report.passed).toBe(false);
    expect(report.failures.some((failure) => failure.startsWith('safe_area_not_clean'))).toBe(true);
    expect(report.detectedTextInSafeArea.length).toBeGreaterThan(0);
  });
});
