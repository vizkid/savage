# Acceptance run script

Manual, in your real Chrome (login + clipboard permission state are profile-bound).
Load the extension unpacked from the repo root, open an **editable** Slides deck.
Expect one clipboard permission prompt the first time — click Allow.

Fixtures: any SVG markup in an editor; a `.svg` file on disk;
a raw SVG URL such as <https://upload.wikimedia.org/wikipedia/commons/4/4f/SVG_Logo.svg>.

| # | Steps | Pass when |
|---|---|---|
| 1 | Copy SVG markup in an editor → click into the Slides tab → Ctrl/Cmd+V | Toast "SVG ready — paste as PNG"; PNG lands, transparent, sharp at full-slide size |
| 2 | Copy SVG elsewhere → Alt/Cmd-Tab back (no click) → Ctrl/Cmd+V | Same as 1 (focus trigger needs no click; keydown is backstop) |
| 3 | Figma → Copy as SVG → paste in Slides | Same as 1 |
| 4 | SVG with `viewBox` but no width/height | Correct aspect, 2048 longest side (checked in unit tests too; spot-check visually) |
| 5 | Wide 4:1 SVG | 2048×512, not distorted |
| 6 | Copy plain text / ordinary image / rich HTML → focus Slides → paste | **No toast**, paste behaves exactly as stock Slides |
| 7 | After a conversion, paste into VS Code | Original SVG markup appears (text/plain preserved) |
| 8 | Paste twice in a row in Slides | Both paste PNG; only one toast/conversion (loop guard) |
| 9 | Copy malformed SVG (`<svg` unclosed) → focus Slides | Error toast; clipboard unchanged (paste still yields the broken text) |
| 10 | Open a Google **Docs** document | Extension inert: no toast ever, no console errors (script injects but bails) |
| 11 | Drag a `.svg` file from Finder onto a slide | Toast "SVG placed"; image lands with no keypress (clipboard still holds PNG + markup as fallback) |
| 12 | Drag an SVG image onto a slide from: (a) the raw SVG URL above opened in a tab, (b) a Commons `File:` page, (c) a Wikipedia article thumbnail | All three: fetched via service worker (wiki pages rewritten through `Special:FilePath`), converted, auto-placed |
| 13 | Drag a PNG or JPEG onto a slide | Extension does nothing; native drop works as stock |
| 14 | Click toolbar icon → set output px to 1024 → paste an SVG; then clear the field → paste again | First paste is 1024 longest side; second is back to 2048 |
| 15 | With "any site" off, drag an SVG image from a non-CORS site; then enable the popup toggle and retry | First: error toast naming the cross-origin block; after enabling (Chrome prompts once): same drag converts |

Also: with the extension loaded and idle, the Slides console shows no errors.
