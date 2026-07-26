#!/bin/sh
# Build the Web Store zip. The file list is derived FROM manifest.json (every
# content script, the service worker, the popup, and all icons) so it can never
# drift out of sync with the code again — plus popup.js (loaded by popup.html)
# and the vendor license file.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -e "console.log(require('./manifest.json').version)")
OUT="store/savage-$VERSION.zip"

FILES=$(node -e '
const m = require("./manifest.json");
const set = new Set(["manifest.json", "popup.js", "vendor/LICENSES.md"]);
(m.content_scripts || []).forEach((cs) => (cs.js || []).forEach((f) => set.add(f)));
if (m.background && m.background.service_worker) set.add(m.background.service_worker);
if (m.action && m.action.default_popup) set.add(m.action.default_popup);
Object.values(m.icons || {}).forEach((f) => set.add(f));
Object.values((m.action && m.action.default_icon) || {}).forEach((f) => set.add(f));
console.log([...set].join("\n"));
')

# Fail loudly if any referenced file is missing (a broken zip is worse than none).
missing=""
for f in $FILES; do [ -f "$f" ] || missing="$missing $f"; done
if [ -n "$missing" ]; then echo "ERROR: missing files:$missing" >&2; exit 1; fi

rm -f "$OUT"
echo "$FILES" | zip -q "$OUT" -@
echo "built $OUT"
unzip -l "$OUT"
