import {
  DetectModerationLabelsCommand,
  DetectTextCommand,
  RekognitionClient,
  type TextDetection,
} from '@aws-sdk/client-rekognition';

import type { ImageValidationReport, TextSafeArea } from '@mrp/shared';
import { RetryableError } from '@mrp/shared';

import type { ImageValidator, ImageValidationRequest } from '../types.js';
import { LocalImageValidator } from './local.js';

/**
 * Production image validator: the offline geometry/cleanliness checks plus real
 * OCR and moderation.
 *
 * In overlay/hybrid mode any detected word whose bounding box overlaps the
 * reserved area is fatal - the drawn quote would collide with it. Text elsewhere
 * in the frame is recorded and, above a small tolerance, also rejected, because
 * the prompt asked for no readable text at all.
 */

export interface RekognitionImageValidatorOptions {
  client?: RekognitionClient;
  region?: string;
  /** Ignore OCR hits below this confidence. */
  minTextConfidence?: number;
  /** Words tolerated outside the reserved area before the image is rejected. */
  maxIncidentalWords?: number;
  /** Moderation labels at or above this confidence are fatal. */
  minModerationConfidence?: number;
  local?: LocalImageValidator;
}

const overlapsSafeArea = (detection: TextDetection, area: TextSafeArea): boolean => {
  const box = detection.Geometry?.BoundingBox;
  if (!box) return false;
  const left = box.Left ?? 0;
  const top = box.Top ?? 0;
  const right = left + (box.Width ?? 0);
  const bottom = top + (box.Height ?? 0);
  return (
    left < area.x + area.width && right > area.x && top < area.y + area.height && bottom > area.y
  );
};

export class RekognitionImageValidator implements ImageValidator {
  private readonly client: RekognitionClient;

  private readonly local: LocalImageValidator;

  public constructor(private readonly options: RekognitionImageValidatorOptions = {}) {
    this.client = options.client ?? new RekognitionClient({ region: options.region });
    this.local = options.local ?? new LocalImageValidator();
  }

  public async validate(request: ImageValidationRequest): Promise<ImageValidationReport> {
    const base = await this.local.validate(request);
    const failures = [...base.failures];
    const minTextConfidence = this.options.minTextConfidence ?? 80;
    const maxIncidentalWords = this.options.maxIncidentalWords ?? 0;
    const minModerationConfidence = this.options.minModerationConfidence ?? 60;

    const image = { Bytes: request.image.data };

    let textResponse;
    let moderationResponse;
    try {
      [textResponse, moderationResponse] = await Promise.all([
        this.client.send(new DetectTextCommand({ Image: image })),
        this.client.send(new DetectModerationLabelsCommand({ Image: image, MinConfidence: 50 })),
      ]);
    } catch (error) {
      // A validation outage must not silently pass an unvalidated image.
      throw new RetryableError('Rekognition validation call failed', { cause: error });
    }

    const words = (textResponse.TextDetections ?? []).filter(
      (detection) =>
        detection.Type === 'WORD' && (detection.Confidence ?? 0) >= minTextConfidence,
    );

    const detectedText = words
      .map((detection) => detection.DetectedText)
      .filter((value): value is string => Boolean(value));

    const inSafeArea = words.filter((detection) =>
      overlapsSafeArea(detection, request.textSafeArea),
    );
    const detectedTextInSafeArea = inSafeArea
      .map((detection) => detection.DetectedText)
      .filter((value): value is string => Boolean(value));

    if (request.quoteRenderMode !== 'embedded_ai' && detectedTextInSafeArea.length > 0) {
      failures.push(`text_in_reserved_area:${detectedTextInSafeArea.length}`);
    }
    if (detectedText.length - detectedTextInSafeArea.length > maxIncidentalWords) {
      failures.push(`incidental_text:${detectedText.length - detectedTextInSafeArea.length}`);
    }

    const moderationLabels = (moderationResponse.ModerationLabels ?? [])
      .filter((label) => (label.Confidence ?? 0) >= minModerationConfidence)
      .map((label) => label.Name ?? 'UNKNOWN');

    if (moderationLabels.length > 0) {
      failures.push(`moderation:${moderationLabels.join('|')}`);
    }

    return {
      ...base,
      detectedText,
      detectedTextInSafeArea,
      moderationLabels,
      failures,
      passed: failures.length === 0,
    };
  }
}
