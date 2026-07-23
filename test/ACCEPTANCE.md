# Acceptance run script

Manual, in your real Chrome (login + clipboard permission state are profile-bound).
Load the extension unpacked from the repo root, open an **editable** Slides deck.
Expect one clipboard permission prompt the first time. Click Allow.

Fixtures: any SVG markup in an editor; a `.svg` file on disk;
a raw SVG URL such as <https://upload.wikimedia.org/wikipedia/commons/4/4f/SVG_Logo.svg>.

| # | Steps | Pass when |
|---|---|---|
| 1 | Copy SVG markup in an editor → click into the Slides tab → Ctrl/Cmd+V | Toast "SVG ready. Paste as PNG"; PNG lands, transparent, sharp at full-slide size |
| 2 | Copy SVG elsewhere → Alt/Cmd-Tab back (no click) → Ctrl/Cmd+V | Same as 1 (focus trigger needs no click; keydown is backstop) |
| 3 | Figma → Copy as SVG → paste in Slides | Same as 1 |
| 4 | SVG with `viewBox` but no width/height | Correct aspect, 2048 longest side (checked in unit tests too; spot-check visually) |
| 5 | Wide 4:1 SVG | 2048×512, not distorted |
| 6 | Copy plain text / ordinary image / rich HTML → focus Slides → paste | **No toast**, paste behaves exactly as stock Slides |
| 7 | After a conversion, paste into VS Code | Original SVG markup appears (text/plain preserved) |
| 8 | Paste twice in a row in Slides | Both paste PNG; only one toast/conversion (loop guard) |
| 9 | Copy malformed SVG (`<svg` unclosed) → focus Slides | Error toast; clipboard unchanged (paste still yields the broken text) |
| 10 | Open a Google **Docs** document | Extension inert: no toast ever, no console errors (script injects but bails) |
| 11 | Drag a `.svg` file from Finder onto a slide | In-scope SVG: toast "SVG pasted as editable shapes", native shapes land. Out-of-scope: toast "SVG placed", image lands. No keypress either way |
| 12 | Drag an SVG image onto a slide from: (a) the raw SVG URL above opened in a tab, (b) a Commons `File:` page, (c) a Wikipedia article thumbnail | All three: fetched via service worker (wiki pages rewritten through `Special:FilePath`), then vector paste when in scope, PNG otherwise |
| 13 | Drag a PNG or JPEG onto a slide | Extension does nothing; native drop works as stock |
| 14 | Click toolbar icon → set output px to 1024 → paste an SVG; then clear the field → paste again | First paste is 1024 longest side; second is back to 2048 |
| 15 | With "any site" off, drag an SVG image from a non-CORS site; then enable the popup toggle and retry | First: error toast naming the cross-origin block; after enabling (Chrome prompts once): same drag converts |

| 16 | Drag a multi-feature in-scope SVG (rect+stroke, circle, cubic path, evenodd donut, linear gradient — e.g. the golden fixture in `VECTOR-SPEC.md` testing notes) onto a slide | Toast "SVG pasted as editable shapes"; every shape individually selectable/editable; gradient runs the right direction; deck reloads with shapes intact (server sync, no 400 banner) |
| 17 | *(v2 update)* Drag an SVG containing `<text>` onto a slide | **Editable outlined-text shapes** (text-to-curves); see rows 26-27 for font-ladder cases |
| 18 | *(v2 update)* Drag an SVG with a filter (blur) onto a slide | PNG fallback, effect preserved in the raster |
| 18b | Drag an SVG with `fill-opacity` / rgba fills onto a slide | **Native shapes with translucent fills** (style key 16); overlap shows through |

### v2: vectors by default (VECTOR2-SPEC.md)

| # | Steps | Pass when |
|---|---|---|
| 19 | Copy in-scope SVG markup → focus Slides (conversion toast) → Cmd+V | Native **editable shapes** land (toast "SVG pasted as editable shapes") — not a PNG. Repeat Cmd+V lands another copy |
| 20 | Copy in-scope SVG → focus Slides → now copy ordinary text elsewhere → back to Slides → Cmd+V | The text pastes natively; no shapes, no Savage toast (stale stash must not fire) |
| 21 | Copy an out-of-scope SVG (e.g. with `<text>`) → focus Slides → Cmd+V | PNG lands exactly as v1 (toast "SVG ready. Paste as PNG" on conversion) |
| 22 | After any conversion, paste into VS Code | Original SVG markup appears (text/plain preserved — row 7 regression) |
| 23 | Convert an SVG (any flow) → paste lands as shapes → Cmd+Z → **Cmd+Shift+V** | The same SVG lands as **PNG**; toast "Pasted as PNG" |
| 24 | Convert an SVG → copy unrelated rich text elsewhere → back to Slides → Cmd+Shift+V | Behaves as native paste-without-formatting: the plain text pastes; no PNG, no Savage toast |
| 25 | Fresh Slides tab, nothing converted yet → Cmd+Shift+V with rich text on clipboard | Native paste-without-formatting, untouched |
| 26 | Drag an SVG with `<text font-family="Lobster">` (any Google Font not installed locally), optional "any site" access **granted** | Outlined text lands in the fetched face, editable shapes |
| 27 | Same SVG with "any site" access **revoked** | Still converts — outlined text in bundled Roboto (ladder degrades, never breaks) |
| 28 | Golden text replay: converter output for a text SVG via Cmd+Shift+9 | Renders, syncs (no 400), survives reload |
| 29 | Drag a logo exported by Illustrator/Figma that styles fills via a `<style>` block + `class="cls-N"` (e.g. Google_Cloud_logo.svg) | Native shapes with correct brand colors — not PNG, no error toast |
| 30 | Drag an SVG that genuinely can't convert while the tab isn't focused | Falls back to PNG and still auto-places; never the "clipboard write was blocked" error |

Also: with the extension loaded and idle, the Slides console shows no errors.
Vector run 2026-07-23: 16 (golden replay + live drop) and 17 passed live; unit
suite 53/53.
