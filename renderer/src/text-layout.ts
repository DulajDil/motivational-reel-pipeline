import type { TextSafeArea } from '@mrp/shared';
import { BRAND_TYPOGRAPHY } from '@mrp/providers';

/**
 * Quote layout.
 *
 * Deterministic word wrapping and auto-fit so the exact quote always lands
 * inside the reserved area with generous breathing room. No measurement of the
 * real font happens here - an average glyph-width ratio is good enough for a
 * handwritten face at these sizes, and the result is stable and testable.
 */

export interface LayoutOptions {
  text: string;
  area: TextSafeArea;
  canvasWidth: number;
  canvasHeight: number;
  /** Fraction of the area left as padding on each side. */
  padding?: number;
  maxFontSize?: number;
  minFontSize?: number;
  /** Average glyph advance as a fraction of font size. */
  glyphWidthRatio?: number;
  lineHeightRatio?: number;
  /** Centred matches the brand reference; left is kept for experiments. */
  align?: 'center' | 'left';
}

export interface QuoteLayout {
  lines: string[];
  fontSize: number;
  lineSpacing: number;
  /** Top-left pixel position of the first line's baseline box. */
  x: number;
  y: number;
  blockWidth: number;
  blockHeight: number;
  align: 'center' | 'left';
  /** Horizontal centre of the reserved area, used for centred drawtext. */
  centreX: number;
}

const wrap = (words: string[], maxChars: number): string[] => {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || current === '') {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
};

export const layoutQuote = (options: LayoutOptions): QuoteLayout => {
  const padding = options.padding ?? 0.08;
  const glyphWidthRatio = options.glyphWidthRatio ?? 0.46;
  const lineHeightRatio = options.lineHeightRatio ?? BRAND_TYPOGRAPHY.lineHeightRatio;
  const maxFontSize = options.maxFontSize ?? BRAND_TYPOGRAPHY.maxFontSize;
  const minFontSize = options.minFontSize ?? BRAND_TYPOGRAPHY.minFontSize;

  const areaWidth = options.area.width * options.canvasWidth;
  const areaHeight = options.area.height * options.canvasHeight;
  const usableWidth = areaWidth * (1 - padding * 2);
  const usableHeight = areaHeight * (1 - padding * 2);

  const words = options.text.trim().split(/\s+/).filter(Boolean);

  let chosen: { lines: string[]; fontSize: number } | undefined;
  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 2) {
    const maxChars = Math.max(8, Math.floor(usableWidth / (fontSize * glyphWidthRatio)));
    const lines = wrap(words, maxChars);
    const blockHeight = lines.length * fontSize * lineHeightRatio;
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const blockWidth = longest * fontSize * glyphWidthRatio;
    if (blockHeight <= usableHeight && blockWidth <= usableWidth) {
      chosen = { lines, fontSize };
      break;
    }
  }

  // Nothing fit even at the minimum size: use the minimum and let validation
  // catch it rather than silently rendering something illegible.
  const fontSize = chosen?.fontSize ?? minFontSize;
  const lines =
    chosen?.lines ??
    wrap(words, Math.max(8, Math.floor(usableWidth / (fontSize * glyphWidthRatio))));

  const lineSpacing = Math.round(fontSize * (lineHeightRatio - 1));
  const blockHeight = lines.length * fontSize + (lines.length - 1) * lineSpacing;
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const blockWidth = Math.round(longest * fontSize * glyphWidthRatio);

  const areaX = options.area.x * options.canvasWidth;
  const areaY = options.area.y * options.canvasHeight;

  return {
    lines,
    fontSize,
    lineSpacing,
    x: Math.round(areaX + areaWidth * padding),
    y: Math.round(areaY + (areaHeight - blockHeight) / 2),
    blockWidth,
    blockHeight,
    align: options.align ?? 'center',
    centreX: Math.round(areaX + areaWidth / 2),
  };
};
