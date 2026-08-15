#!/usr/bin/env bash
#
# Fetch the handwritten quote font.
#
# No font binary is committed to this repository: fonts carry their own licences
# and vendoring one silently is the kind of rights problem this project exists to
# avoid. This script downloads Patrick Hand, the closest practical match to the
# approved reference frame's lettering. It is published under the SIL Open Font
# Licence 1.1 and may be embedded in rendered video.
#
# Kalam is a slightly more polished alternative:
#   FONT_URL=https://raw.githubusercontent.com/google/fonts/main/ofl/kalam/Kalam-Regular.ttf \
#   LICENSE_URL=https://raw.githubusercontent.com/google/fonts/main/ofl/kalam/OFL.txt \
#   FONT_NAME=Kalam npm run fonts:fetch
#
# If you prefer a different face, drop the .ttf/.otf into renderer/fonts and put
# its licence text alongside it. The renderer picks up whatever is there.

set -euo pipefail

FONT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/renderer/fonts"
FONT_NAME="${FONT_NAME:-PatrickHand}"
FONT_URL="${FONT_URL:-https://raw.githubusercontent.com/google/fonts/main/ofl/patrickhand/PatrickHand-Regular.ttf}"
LICENSE_URL="${LICENSE_URL:-https://raw.githubusercontent.com/google/fonts/main/ofl/patrickhand/OFL.txt}"

mkdir -p "${FONT_DIR}"

# Only one font may be present: the renderer picks the first it finds, and two
# would make the choice depend on filename ordering.
rm -f "${FONT_DIR}"/*.ttf "${FONT_DIR}"/*.otf

echo "Downloading font to ${FONT_DIR}/${FONT_NAME}.ttf"
curl -fsSL "${FONT_URL}" -o "${FONT_DIR}/${FONT_NAME}.ttf"

echo "Downloading licence to ${FONT_DIR}/OFL.txt"
curl -fsSL "${LICENSE_URL}" -o "${FONT_DIR}/OFL.txt"

echo
echo "Done. Font licence:"
head -3 "${FONT_DIR}/OFL.txt"
echo
echo "The renderer will now use this font. It is gitignored on purpose;"
echo "the container image build bakes it in from this directory."
