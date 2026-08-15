import type { ImageValidationReport } from '@mrp/shared';

import { decodePng, readImageDimensions } from '../image/png.js';
import type { ImageValidator, ImageValidationRequest } from '../types.js';

/**
 * Offline image validator.
 *
 * Checks that can be made without any AWS call:
 *   - format and exact pixel dimensions,
 *   - the image is not blank or near-uniform (a failed generation often is),
 *   - the reserved text area is actually clean.
 *
 * "Clean" is measured as ink density: the fraction of pixels in the reserved
 * area that are much darker than the area's median. Accidental lettering, a
 * signature or stray linework all raise it. This is a proxy for OCR, not a
 * replacement - in AWS the Rekognition validator runs real text detection on top
 * of these checks.
 */

export interface LocalImageValidatorOptions {
  /** Maximum fraction of dark pixels tolerated inside the reserved area. */
  maxSafeAreaInkDensity?: number;
  /** Minimum overall contrast; below this the frame is effectively blank. */
  minStdDev?: number;
}

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
};

export class LocalImageValidator implements ImageValidator {
  public constructor(private readonly options: LocalImageValidatorOptions = {}) {}

  public async validate(request: ImageValidationRequest): Promise<ImageValidationReport> {
    const failures: string[] = [];
    const maxInk = this.options.maxSafeAreaInkDensity ?? 0.06;
    const minStdDev = this.options.minStdDev ?? 6;

    let dimensions;
    try {
      dimensions = readImageDimensions(request.image.data);
    } catch (error) {
      return {
        passed: false,
        width: 0,
        height: 0,
        format: 'unknown',
        maxSimilarity: 0,
        detectedText: [],
        detectedTextInSafeArea: [],
        moderationLabels: [],
        failures: [`undecodable_image:${(error as Error).message}`],
      };
    }

    if (dimensions.width !== request.expectedWidth || dimensions.height !== request.expectedHeight) {
      failures.push(
        `wrong_dimensions:${dimensions.width}x${dimensions.height}!=${request.expectedWidth}x${request.expectedHeight}`,
      );
    }

    const detectedTextInSafeArea: string[] = [];

    if (dimensions.format === 'png') {
      try {
        const { width, height, rgb } = decodePng(request.image.data);

        // Global contrast: catch blank or near-uniform output.
        let sum = 0;
        let sumSquares = 0;
        const total = width * height;
        const globalLumas: number[] = [];
        for (let index = 0; index < total; index += 1) {
          const luma =
            0.299 * rgb[index * 3]! + 0.587 * rgb[index * 3 + 1]! + 0.114 * rgb[index * 3 + 2]!;
          sum += luma;
          sumSquares += luma * luma;
          // Sample sparsely for the median; the full sort would be wasteful.
          if (index % 97 === 0) globalLumas.push(luma);
        }
        const mean = sum / total;
        const stdDev = Math.sqrt(Math.max(0, sumSquares / total - mean * mean));
        if (stdDev < minStdDev) failures.push(`low_contrast:${stdDev.toFixed(1)}`);

        // Ink density inside the reserved area.
        //
        // The reference tone is the WHOLE image's median, not the reserved
        // area's own median. Using the local median would let a uniformly
        // inked-over area look clean: everything in it would sit at the
        // "background" level and nothing would read as ink.
        const paperTone = percentile(globalLumas, 0.5);
        const area = request.textSafeArea;
        const x0 = Math.floor(area.x * width);
        const x1 = Math.min(width, Math.ceil((area.x + area.width) * width));
        const y0 = Math.floor(area.y * height);
        const y1 = Math.min(height, Math.ceil((area.y + area.height) * height));

        const lumas: number[] = [];
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const offset = (y * width + x) * 3;
            lumas.push(
              0.299 * rgb[offset]! + 0.587 * rgb[offset + 1]! + 0.114 * rgb[offset + 2]!,
            );
          }
        }
        const inkThreshold = paperTone - 45;
        const inkPixels = lumas.filter((luma) => luma < inkThreshold).length;
        const inkDensity = lumas.length === 0 ? 0 : inkPixels / lumas.length;

        if (request.quoteRenderMode !== 'embedded_ai' && inkDensity > maxInk) {
          // In overlay/hybrid mode the area must stay clean for the drawn quote.
          detectedTextInSafeArea.push(`ink_density=${inkDensity.toFixed(3)}`);
          failures.push(`safe_area_not_clean:${inkDensity.toFixed(3)}>${maxInk}`);
        }
      } catch (error) {
        failures.push(`png_decode_failed:${(error as Error).message}`);
      }
    }

    return {
      passed: failures.length === 0,
      width: dimensions.width,
      height: dimensions.height,
      format: dimensions.format,
      maxSimilarity: 0,
      detectedText: [],
      detectedTextInSafeArea,
      moderationLabels: [],
      failures,
    };
  }
}
