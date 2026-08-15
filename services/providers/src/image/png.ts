import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal PNG encoder/decoder.
 *
 * Written by hand so the mock image provider needs no native dependency and no
 * network: unit tests and `npm run dry-run` produce a real 1080x1920 PNG on any
 * machine with Node alone.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);

  // 4-byte length + body (type + data) + 4-byte CRC.
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
};

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode 8-bit RGB pixel data (row-major, no alpha) as a PNG. */
export const encodePng = (width: number, height: number, rgb: Uint8Array): Uint8Array => {
  if (rgb.length !== width * height * 3) {
    throw new RangeError(`Expected ${width * height * 3} bytes of RGB data, got ${rgb.length}`);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline.
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const idat = new Uint8Array(deflateSync(raw, { level: 6 }));
  const chunks = [
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
};

export interface ImageDimensions {
  width: number;
  height: number;
  format: 'png' | 'jpeg';
}

/**
 * Read dimensions straight from the byte stream. Used by the validator so an
 * image never reaches the renderer without its geometry being confirmed.
 */
export const readImageDimensions = (bytes: Uint8Array): ImageDimensions => {
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), format: 'png' };
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      // SOF0..SOF15 excluding DHT/JPG/DAC carry the frame geometry.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
          format: 'jpeg',
        };
      }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      offset += 2 + length;
    }
  }

  throw new Error('Unsupported image format: expected PNG or JPEG');
};

export interface DecodedPng {
  width: number;
  height: number;
  /** 8-bit RGB, row-major, no alpha. */
  rgb: Uint8Array;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/**
 * Decode a truecolour (type 2 or 6) 8-bit PNG. Enough to let the local validator
 * inspect the reserved text area without a native image dependency; anything
 * more exotic is rejected rather than guessed at.
 */
export const decodePng = (bytes: Uint8Array): DecodedPng => {
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colourType = bytes[25];
  if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) {
    throw new Error(`Unsupported PNG: bitDepth=${bitDepth} colourType=${colourType}`);
  }
  const channels = colourType === 2 ? 3 : 4;

  const idatParts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'IDAT') idatParts.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  const compressed = new Uint8Array(idatParts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of idatParts) {
    compressed.set(part, cursor);
    cursor += part.length;
  }

  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 3);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    current.set(raw.subarray(rowStart + 1, rowStart + 1 + stride));

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? current[i - channels]! : 0;
      const b = previous[i]!;
      const c = i >= channels ? previous[i - channels]! : 0;
      const x = current[i]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          current[i] = (x + a) & 0xff;
          break;
        case 2:
          current[i] = (x + b) & 0xff;
          break;
        case 3:
          current[i] = (x + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          current[i] = (x + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported PNG filter type ${filter}`);
      }
    }

    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 3;
      out[dst] = current[src]!;
      out[dst + 1] = current[src + 1]!;
      out[dst + 2] = current[src + 2]!;
    }
    previous.set(current);
  }

  return { width, height, rgb: out };
};
