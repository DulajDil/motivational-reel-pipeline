#!/usr/bin/env bash
#
# Fetch the handwritten quote font.
#
# No font binary is committed to this repository: fonts carry their own licences
# and vendoring one silently is the kind of rights problem this project exists to
# avoid. This script downloads Caveat, which is published under the SIL Open Font
# Licence 1.1 and may be embedded in rendered video.
#
# If you prefer a different face, drop the .ttf/.otf into renderer/fonts and put
# its licence text alongside it. The renderer picks up whatever is there.

set -euo pipefail

FONT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/renderer/fonts"
FONT_URL="${FONT_URL:-https://raw.githubusercontent.com/google/fonts/main/ofl/caveat/Caveat%5Bwght%5D.ttf}"
LICENSE_URL="${LICENSE_URL:-https://raw.githubusercontent.com/google/fonts/main/ofl/caveat/OFL.txt}"

mkdir -p "${FONT_DIR}"

echo "Downloading font to ${FONT_DIR}/Caveat.ttf"
curl -fsSL "${FONT_URL}" -o "${FONT_DIR}/Caveat.ttf"

echo "Downloading licence to ${FONT_DIR}/OFL.txt"
curl -fsSL "${LICENSE_URL}" -o "${FONT_DIR}/OFL.txt"

echo
echo "Done. Font licence:"
head -3 "${FONT_DIR}/OFL.txt"
echo
echo "The renderer will now use this font. It is gitignored on purpose;"
echo "the container image build bakes it in from this directory."
