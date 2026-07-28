# Savage

A Chrome extension that pastes SVGs into Google Slides as native, editable
shapes.

Google Slides cannot paste or drop SVGs. Savage converts them on the way in.
Copy an SVG or drag one onto a slide and it lands as editable Slides shapes:
paths, basic shapes, gradients, and text converted to outlines. When part of an
SVG cannot be represented as a shape (embedded bitmaps, cropping clip paths,
masks, filters), that SVG falls back to a transparent PNG instead, so a paste
always produces something.

Everything runs locally. There are no accounts and no analytics. The only
network requests are fetching an SVG you drag from a website, and fetching a
font from Google Fonts when an SVG's text uses one that is not embedded in the
file.

## Converts to shapes

- `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`
- Solid and translucent fills, strokes, linear and centered radial gradients
- Fills set by presentation attributes, inline `style`, or CSS class rules in a
  `<style>` block
- Groups, transforms, and nested `<svg>` viewports
- `<text>`, converted to outlined curves using the embedded font, a matching
  Google Font, or a bundled fallback font

Each paste is placed as one group with a transparent rectangle behind it, so it
moves as a single object and can be used as a target for diagram connectors.
Pastes larger than about four inches are scaled down to fit the slide, aspect
preserved.

## Falls back to PNG

Embedded `<image>` bitmaps, clip paths that actually crop content, masks,
filters, patterns, `<use>` of external references, and partially transparent
strokes. The PNG is transparent and sized by the output-size setting.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick
   this folder. (A Web Store submission kit is in `store/`.)
2. Open a Google Slides deck. The first conversion triggers one clipboard
   permission prompt. Click Allow; it does not ask again.

Savage requests no site access by default. Dragged web images are fetched under
CORS, which works for Wikipedia and Wikimedia. For sites that block that, and
to fetch Google Fonts for text conversion, enable "fetch from any site" in the
toolbar popup.

## Use

- **Paste:** copy SVG markup (editor, devtools, Figma "Copy as SVG") or an SVG
  image, switch to Slides, and paste. In-scope SVGs arrive as editable shapes;
  the rest arrive as a PNG.
- **Drop:** drag a `.svg` file, an SVG image from another site (including
  Wikipedia and Commons pages), or selected SVG markup onto a slide. It is
  placed automatically. If Slides ignores the synthetic paste, the toast asks
  you to paste manually; the clipboard is already loaded.
- **Paste as PNG:** after a conversion, press Ctrl/Cmd+Shift+V to place the PNG
  version instead of the shapes.
- **Output size:** click the toolbar icon to set the PNG's longest side
  (256–8192 px, default 2048). This affects the PNG fallback only.

Pasting into a text editor afterwards still yields the original SVG markup; only
the image data on the clipboard is rewritten.

## Limitations

- Google Slides only (not Docs, Sheets, or Drawings). Chrome only.
- `.svg` files *copied* in Finder or Explorer cannot be read from the clipboard.
  Drag the file in instead.
- Auto-place lands at Slides' default paste position, not the drop point.
- On view-only decks the conversion runs but the paste cannot place anything.
- The extension reads the clipboard when a Slides tab gains focus or you press a
  modifier key there. Contents are inspected locally for SVG and never leave the
  page.

## How it works

Slides accepts its own internal vector clipboard format
(`application/x-vnd.google-docs-drawings-object+wrapped`). Savage builds that
payload from the SVG and delivers it with a synthetic paste event. The format
and the conversion are documented in `VECTOR-SPEC.md`, `VECTOR2-SPEC.md`, and
`research/FINDINGS.md`.
