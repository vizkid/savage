#!/bin/sh
# Build the Web Store zip: extension files only, nothing else.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -e "console.log(require('./manifest.json').version)")
OUT="store/savage-$VERSION.zip"
rm -f "$OUT"
zip -q "$OUT" manifest.json config.js rasterize.js content.js sw.js popup.html popup.js icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
echo "built $OUT"
unzip -l "$OUT"
