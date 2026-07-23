# Vector paste research

Goal: convert SVG into Google Slides' internal clipboard format
(`application/x-vnd.google-docs-document-slice-clip+wrapped`) so pastes land
as native, editable vector shapes instead of PNGs.

Two facts shape the approach:

1. The async clipboard API cannot read or write custom MIME types, so delivery
   has to go through a synthetic paste event carrying `DataTransfer.setData()`
   with the custom type. Savage already uses that channel for auto-place.
2. Chromium pickles Google's custom clipboard types as web-custom-data, which
   any page's paste event can read via `clipboardData.getData()`. Capturing
   pristine payloads is therefore trivial.

## Spike A: capture payloads (dump.html)

Open `dump.html` in a tab. In Slides or Drawings, select a shape, Cmd+C, then
paste into the dump page. Each paste downloads a `savage-clip-dump-*.json`
with every clipboard flavor. Capture at least:

1. A plain rectangle
2. A rectangle with a custom fill and stroke
3. A freeform curve (Insert → Line → Curve)
4. Two shapes grouped
5. The same rectangle copied from Google Drawings instead of Slides

## Spike B: replay (spike-vector/)

Load `spike-vector/` unpacked. Copy the *contents* of a dump JSON file as
text, focus the Slides tab, press Ctrl/Cmd+Shift+9. The probe rebuilds the
DataTransfer from the dump and dispatches a synthetic paste. Success looks
like the original shape appearing, still editable as a vector. Console tag:
`[vector-spike]`.

If replay works, the remaining work is pure format engineering: diff the
dumps to map the schema, then write an SVG-to-slice-clip converter for a
supported subset (paths and basic shapes with solid fills/strokes first).
If Slides rejects synthetic pastes of the custom type, the whole feature is
dead and we document why here.
