# Chrome Web Store listing kit

Everything the dashboard asks for, in order. Upload `savage-<version>.zip`
(build with `./store/build.sh`). Current version: **2.0.0**.

## Basics

- **Name:** Savage
- **Short description** (≤132 chars):
  Paste SVGs into Google Slides as native, editable shapes. Copy or drag one in — it lands recolorable and scalable, or PNG.
- **Category:** Workflow & Planning (or Tools)
- **Language:** English
- **Homepage:** https://github.com/vizkid/savage
- **Privacy policy URL:** https://vizkid.github.io/savage/privacy.html

## Detailed description

Google Slides has no SVG support: paste one and you get raw markup in a text
box. Savage fixes that. Copy an SVG (markup, a Figma "Copy as SVG", an SVG
image) or drag one onto a slide, and it arrives as **native Google Slides
shapes** — recolorable, scalable, and editable like anything you drew by hand.

Under the hood it converts SVG paths, basic shapes, gradients, and text into
Slides' own vector format. When something can't be represented as a shape
(embedded bitmaps, clip masks, filters), it falls back automatically to a
sharp, transparent PNG — so a paste never fails, it just gives you the best
result possible.

• Paths, rectangles, circles, polygons, and gradients become editable shapes
• Text is converted to outlined curves, so it scales and recolors cleanly
• Multi-shape logos arrive grouped, ready to move or resize as one object
• Solid and translucent fills, strokes, and CSS-class styling all supported
• Anything unsupported falls back to a high-res transparent PNG, never fails
• Copy → paste, drag a .svg file, or drag an SVG image from another site
• Runs locally: no accounts, no analytics, no data collection

Slides only. Requires clipboard access (granted once) so conversion can happen
before you paste.

## Single purpose statement

Converts SVG images into native, editable Google Slides shapes (or a
high-resolution PNG fallback) on their way into a presentation, via clipboard
rewrite or drag-and-drop, because Slides cannot accept SVGs natively.

## Permission justifications

- **clipboardRead**: detects whether the clipboard holds an SVG when a Google
  Slides tab is focused, so it can be converted before the user pastes.
  Contents are inspected locally and never stored or transmitted.
- **clipboardWrite**: replaces the clipboard's contents with the converted
  result (the original SVG markup is preserved as text).
- **storage**: persists a single user setting — the PNG-fallback output size.
- **declarativeNetRequestWithHostAccess**: when converting SVG text whose font
  is not embedded, the extension fetches that font from Google Fonts. Google's
  font API only serves the TrueType format (which the extension can read) to
  older browser identifiers, so a session rule adjusts the User-Agent header on
  the extension's own requests to fonts.googleapis.com. It applies only to
  requests Savage itself makes, only when host access has been granted, and
  never to the user's own browsing.
- **optional_host_permissions `<all_urls>`**: off by default. When the user
  enables "fetch from any site" in the popup, host access is used solely to (a)
  fetch the URL of an SVG image the user dragged from a site that blocks
  cross-origin requests, and (b) fetch fonts from Google Fonts for SVG text
  conversion. Without it, drags still work from CORS-friendly sites and SVG
  text falls back to a bundled font.
- **Content script on docs.google.com**: injected only there; exits
  immediately unless the page is a Slides presentation. Needed to run the
  conversion in the Slides tab and place converted shapes/images.

## Note for reviewers: no remote code

Savage executes no remote code. The Google Fonts request fetches font **data**
(a TrueType file), which is parsed locally to trace glyph outlines — it is
never executed. All executable code ships inside the package: the vendored
libraries in `vendor/` (opentype.js for font parsing, clipper-lib for polygon
normalization, and a bundled Roboto font) are static files, listed in
`vendor/LICENSES.md` (MIT, Boost, and Apache-2.0 respectively).

## Data usage disclosures (dashboard checkboxes)

- Collects **no** user data (no PII, no health/financial/auth info, no user
  activity, no content). Clipboard and dragged content are processed
  ephemerally in memory, locally.
- Data is not sold, not shared with third parties, not used for unrelated
  purposes, not used for creditworthiness. (Check the three certification
  boxes.)

## Assets

- Icons: shipped in the zip (`icons/`, 16/32/48/128).
- Screenshots (1280×800 or 640×400, at least one required): `store/` currently
  has `screenshot-1.png` (landing hero, v1-era). **Replace / add** at least one
  real capture of an SVG landing on a slide as editable shapes — that is the
  headline feature and the old hero doesn't show it. See build/submit steps.
