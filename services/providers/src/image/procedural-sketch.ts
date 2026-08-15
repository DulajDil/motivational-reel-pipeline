import { mulberry32 } from '@mrp/shared';
import type { TextSafeArea } from '@mrp/shared';

import { BRAND_PALETTE } from '../brand-style.js';
import { encodePng } from './png.js';

/**
 * Procedural stand-in illustration.
 *
 * Draws warm cream paper with pencil grain, a soft vignette and a very simple
 * horizon/sun/figure composition, deliberately leaving the reserved text area
 * clean. It is not art - it exists so the renderer, validator and end-to-end
 * tests have a real, deterministic, correctly-sized image with no model call,
 * no network and no committed binary asset.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const PAPER: Rgb = BRAND_PALETTE.paper;
const INK: Rgb = { r: 42, g: 33, b: 24 };
const SEPIA: Rgb = { r: 214, g: 150, b: 76 };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
});

export interface ProceduralSketchOptions {
  width: number;
  height: number;
  seed: number;
  textSafeArea: TextSafeArea;
}

export const renderProceduralSketch = ({
  width,
  height,
  seed,
  textSafeArea,
}: ProceduralSketchOptions): Uint8Array => {
  const random = mulberry32(seed);
  const pixels = new Uint8Array(width * height * 3);

  /*
   * Composition mirrors the approved reference frame: clean parchment across
   * the reserved top band, a low horizon, the sunrise to the right and a small
   * figure standing to the left of it. Derived from the seed, so the same job
   * always draws the same scene.
   */
  const horizonY = height * (0.74 + random() * 0.05);
  const sunX = width * (0.64 + random() * 0.14);
  const sunY = height * (0.62 + random() * 0.05);
  const sunR = width * (0.1 + random() * 0.03);
  const figureX = width * (0.3 + random() * 0.1);
  const figureH = height * (0.17 + random() * 0.03);

  const safeTop = textSafeArea.y * height;
  const safeBottom = (textSafeArea.y + textSafeArea.height) * height;
  const safeLeft = textSafeArea.x * width;
  const safeRight = (textSafeArea.x + textSafeArea.width) * width;

  const cx = width / 2;
  const cy = height / 2;
  const maxDistance = Math.hypot(cx, cy);

  for (let y = 0; y < height; y += 1) {
    const inSafeRow = y >= safeTop && y <= safeBottom;
    for (let x = 0; x < width; x += 1) {
      let colour: Rgb = PAPER;

      // Paper grain.
      const grain = (random() - 0.5) * 14;
      colour = { r: colour.r + grain, g: colour.g + grain * 0.95, b: colour.b + grain * 0.85 };

      const inSafeArea = inSafeRow && x >= safeLeft && x <= safeRight;
      if (!inSafeArea) {
        // Horizon: a soft pencil line with a hand-drawn wobble.
        const wobble = Math.sin(x / 90) * 6 + Math.sin(x / 23) * 2;
        const horizonDistance = Math.abs(y - (horizonY + wobble));
        if (horizonDistance < 2.4) {
          colour = mix(colour, INK, clamp(1 - horizonDistance / 2.4, 0, 1) * 0.75);
        }

        // Sun outline, plus the radiating strokes from the reference frame.
        const sunRadius = Math.hypot(x - sunX, y - sunY);
        const sunDistance = Math.abs(sunRadius - sunR);
        if (sunDistance < 2.2) {
          colour = mix(colour, INK, clamp(1 - sunDistance / 2.2, 0, 1) * 0.6);
        }
        if (sunRadius > sunR && sunRadius < sunR * 2.1 && y < horizonY) {
          const angle = Math.atan2(y - sunY, x - sunX);
          const ray = Math.abs(Math.sin(angle * 12));
          if (ray > 0.97) colour = mix(colour, SEPIA, 0.5);
        }
        if (sunRadius < sunR) {
          colour = mix(colour, SEPIA, 0.28);
        }

        // Warm sepia wash below the horizon.
        if (y > horizonY) {
          const depth = clamp((y - horizonY) / (height - horizonY), 0, 1);
          colour = mix(colour, SEPIA, depth * 0.22);
        }

        // A very simple standing figure: body stroke plus a head outline.
        const bodyTop = horizonY - figureH;
        if (y > bodyTop && y < horizonY && Math.abs(x - figureX) < 3) {
          colour = mix(colour, INK, 0.8);
        }
        const headDistance = Math.abs(
          Math.hypot(x - figureX, y - (bodyTop - figureH * 0.16)) - figureH * 0.14,
        );
        if (headDistance < 2) {
          colour = mix(colour, INK, 0.75);
        }
      }

      // Vignette keeps the eye centred and mimics scanned paper.
      const vignette = clamp(Math.hypot(x - cx, y - cy) / maxDistance, 0, 1);
      colour = mix(colour, { r: 214, g: 200, b: 176 }, vignette * 0.28);

      const offset = (y * width + x) * 3;
      pixels[offset] = clamp(Math.round(colour.r), 0, 255);
      pixels[offset + 1] = clamp(Math.round(colour.g), 0, 255);
      pixels[offset + 2] = clamp(Math.round(colour.b), 0, 255);
    }
  }

  return encodePng(width, height, pixels);
};
