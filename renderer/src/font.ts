import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigurationError } from '@mrp/shared';

/**
 * Font resolution.
 *
 * No font binary is committed to this repository: fonts carry their own licences
 * and vendoring one silently is exactly the kind of rights problem this project
 * is trying to avoid. `npm run fonts:fetch` downloads an SIL Open Font Licence
 * face into renderer/fonts, and the container image bakes it in at build time.
 *
 * Resolution order:
 *   1. QUOTE_FONT_PATH                (explicit override)
 *   2. renderer/fonts/*.ttf|*.otf     (fetched or baked into the image)
 *   3. a system fallback              (local development convenience only)
 */

export interface ResolvedFont {
  family: string;
  file: string;
  sha256: string;
  license: string;
}

const SYSTEM_FALLBACKS = [
  '/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf',
  '/System/Library/Fonts/Supplemental/Chalkboard.ttc',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

const licenseFor = (fontDir: string): string => {
  const licensePath = join(fontDir, 'OFL.txt');
  return existsSync(licensePath)
    ? 'SIL Open Font License 1.1 (renderer/fonts/OFL.txt)'
    : 'UNVERIFIED - system fallback font, not licensed for redistribution';
};

export const resolveFont = (options: { fontDir: string; override?: string | undefined }): ResolvedFont => {
  const candidates: string[] = [];
  if (options.override) candidates.push(options.override);

  if (existsSync(options.fontDir)) {
    const bundled = readdirSync(options.fontDir)
      .filter((name) => /\.(ttf|otf)$/i.test(name))
      .sort()
      .map((name) => join(options.fontDir, name));
    candidates.push(...bundled);
  }

  candidates.push(...SYSTEM_FALLBACKS);

  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) {
    throw new ConfigurationError(
      'No usable font found. Run `npm run fonts:fetch`, or set QUOTE_FONT_PATH to a font you are licensed to embed.',
    );
  }

  const isBundled = file.startsWith(options.fontDir);
  return {
    family: file.split('/').pop() ?? file,
    file,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    license: isBundled ? licenseFor(options.fontDir) : SYSTEM_FALLBACK_LICENSE,
  };
};

export const SYSTEM_FALLBACK_LICENSE =
  'UNVERIFIED - system fallback font used for local development only. Do not publish output rendered with an unverified font.';
