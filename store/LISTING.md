# Chrome Web Store listing kit

Everything the dashboard asks for, in order. Upload `savage-<version>.zip`
(build with `./store/build.sh`).

## Basics

- **Name:** SaVaGe
- **Short description** (≤132 chars):
  Convert SVGs to PNGs for Google Slides. Copy or drag SVGs in and they arrive as high-res transparent PNGs.
- **Category:** Workflow & Planning (or Tools)
- **Language:** English
- **Homepage:** https://github.com/vizkid/savage
- **Privacy policy URL:** https://vizkid.github.io/savage/privacy.html

## Detailed description

Google Slides has no SVG support: paste one and you get markup in a text box.
The vector-preserving workaround involves format converters and a PowerPoint
import. SaVaGe takes the trade: pixels, in exchange for convenience.

Copy an SVG anywhere (markup, a Figma "Copy as SVG", an SVG image) and paste
into Slides: it lands as a sharp transparent PNG, 2048 px on the longest
side. Drag an SVG in (a .svg file, selected markup, or an image from another
site, Wikipedia included) and it places itself on the slide automatically.

• Transparent background, aspect preserved, sharp at full-slide size
• Dropped SVGs insert themselves, no extra paste step
• Pasting into a code editor afterwards still yields the original SVG markup
• One setting: output size (256–8192 px) in the toolbar popup
• Runs entirely locally: no accounts, no analytics, no data collection

Slides only. Requires clipboard access (granted once) so conversion can happen
before you paste.

## Single purpose statement

Converts SVG images into high-resolution transparent PNGs on their way into
Google Slides (via clipboard rewrite or drag-and-drop), because Slides cannot
accept SVGs natively.

## Permission justifications

- **clipboardRead**: detects whether the clipboard holds an SVG when a Google
  Slides tab is focused, so it can be converted before the user pastes.
  Contents are inspected locally and never stored or transmitted.
- **clipboardWrite**: replaces the clipboard's image flavor with the converted
  PNG (the original SVG markup is preserved as text).
- **storage**: persists a single user setting: output size in pixels.
- **optional_host_permissions `<all_urls>`**: off by default. If the user
  enables "fetch dragged SVGs from any site" in the popup, host access is used
  solely to fetch the URL of an SVG image the user just dragged from a website
  that blocks cross-origin requests. Without it, drags still work from
  CORS-friendly sites (e.g. Wikipedia/Wikimedia).
- **Content script on docs.google.com**: injected only there; script exits
  immediately unless the page is a Slides presentation. Needed to run the
  conversion in the Slides tab and place dropped images.

## Data usage disclosures (dashboard checkboxes)

- Collects **no** user data (no PII, no health/financial/auth info, no user
  activity, no content). Clipboard and dragged content are processed
  ephemerally in memory, locally.
- Data is not sold, not shared with third parties, not used for unrelated
  purposes, not used for creditworthiness. (Check the three certification
  boxes.)

## Assets

- Icons: shipped in the zip (`icons/`, 16/32/48/128).
- Screenshot 1280×800: `store/screenshot-1.png` (landing hero). Consider
  replacing/adding a real capture of a paste landing on a slide.
