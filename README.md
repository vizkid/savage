# SaVaGe — Convert SVGs to PNGs for Google Slides

Google Slides can't paste or drop SVGs. This extension fixes that: copy an SVG
anywhere (markup or image) or drag one into a slide, and it lands as a
high-resolution transparent PNG via a clipboard rewrite. No accounts, no
network beyond fetching a URL you just dragged, no analytics — everything runs
locally and nothing leaves your machine.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. Open a Google Slides deck. The first conversion may trigger **one** clipboard
   permission prompt — click Allow; it never asks again.

## Use

- **Paste:** copy SVG markup (editor, devtools, Figma "Copy as SVG") or an SVG
  image → switch to Slides → toast "SVG ready — paste as PNG" → paste.
- **Drop:** drag a `.svg` file, an SVG image from another site (Wikipedia and
  Commons pages included), or selected SVG markup onto a slide → it's placed
  automatically ("SVG placed"). If Slides ever ignores the synthetic paste,
  the toast asks you to paste manually — the clipboard is already loaded.
- **Output size:** click the toolbar icon to set the PNG's longest side
  (256–8192 px, default 2048).

A paste into a text editor afterwards still yields the original SVG markup —
only the image flavor of the clipboard is rewritten.

## Limitations

- Slides only (not Docs/Sheets/Drawings), Chrome only, unpacked only.
- `.svg` files *copied* in Finder/Explorer can't be read from the clipboard —
  drag the file in instead.
- SVGs referencing external images are rejected (they'd render with blanks).
- Auto-place lands at Slides' default paste position, not the exact drop point.
- On view-only decks the drop converts but the paste can't place anything.
- The extension reads the clipboard when a Slides tab gains focus or you press
  a modifier key there. Contents are only inspected for SVG and never leave the
  page.
