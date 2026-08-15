import type { TextSafeArea } from '@mrp/shared';

/**
 * The brand style contract.
 *
 * Every Reel must be recognisably the same series, so the visual recipe lives in
 * exactly one place and is applied identically to the illustration prompt, the
 * reserved text area and the renderer's layout. Nothing downstream is allowed to
 * improvise: if a value is not here, it is not part of the brand.
 *
 * Derived from the approved reference frame:
 *   - vertical 9:16, warm textured cream/parchment paper
 *   - black pencil and ink linework, restrained amber/sepia sunrise shading
 *   - quote centred in the top third, with a thin hand-drawn underline beneath
 *   - character and landscape in the lower two thirds
 *   - generous empty breathing room, soft sketch texture, calm hopeful mood
 */

/**
 * Fraction of the frame reserved for the quote. The illustration prompt asks for
 * this band to be left as clean paper, and the renderer draws into it.
 */
export const RESERVED_TOP_FRACTION = 0.35;

/**
 * The single canonical text area. Deliberately NOT varied per job: consistency
 * across the feed is the point, so every frame places the quote identically.
 */
export const BRAND_TEXT_SAFE_AREA: TextSafeArea = {
  position: 'upper_middle',
  x: 0.08,
  y: 0.08,
  width: 0.84,
  height: 0.24,
};

/** Ink, paper and shading, shared by the prompt and the procedural stand-in. */
export const BRAND_PALETTE = {
  paper: { r: 244, g: 226, b: 189 },
  ink: '0x2A2118',
  underline: '0x3A2E22',
  handle: '0x7A6650',
  shadow: '0xE8D7B4@0.45',
} as const;

/** Typography. The font itself is bundled by `npm run fonts:fetch`. */
export const BRAND_TYPOGRAPHY = {
  /** Preferred family. Patrick Hand is SIL OFL 1.1 and may be embedded in video. */
  fontFamily: 'Patrick Hand',
  /** Centred, mirroring the reference frame. */
  align: 'center' as const,
  maxFontSize: 88,
  minFontSize: 46,
  lineHeightRatio: 1.5,
  /** Thin hand-drawn rule under the quote block. */
  underline: {
    enabled: true,
    /** Width as a fraction of the widest rendered line. */
    widthRatio: 0.62,
    thicknessPx: 3,
    /** Gap between the last line's baseline box and the rule. */
    offsetPx: 34,
  },
} as const;

/**
 * Style clause reused verbatim in every illustration prompt. Kept as one string
 * so the wording cannot drift between call sites.
 */
export const BRAND_STYLE_CLAUSE = [
  'warm textured cream parchment paper,',
  'black hand-drawn pencil and ink linework,',
  'subtle amber and sepia shading, gentle sunrise lighting,',
  'calm hopeful mood, simple expressive illustrated character,',
  'scenic landscape, soft sketch texture, visible pencil hatching.',
].join(' ');
