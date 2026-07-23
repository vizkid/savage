# Savage: Native Vector Paste (spec)

**Owner:** viz · **Last updated:** 2026-07-23 · **Status:** research complete, pre-build

## Problem / solution

Savage currently converts SVGs to PNGs — pixels in exchange for convenience.
But we reverse-engineered Google Slides' internal vector clipboard format
(`application/x-vnd.google-docs-drawings-object+wrapped`; full notes in
`research/FINDINGS.md`), so for a large class of SVGs we can do better: paste
them as **native, editable Slides shapes**. No pixels, infinitely scalable,
recolorable in Slides.

The converter is best-effort with a safety net: if an SVG uses anything we
can't map, we silently fall back to the existing PNG pipeline. The user always
gets *something*; when possible, they get vectors.

## Core insight

**Slides' path opcodes are a complete SVG path renderer.** M→op0, L→op1, C→op3,
Z→op5; Q and elliptical-arc commands decompose to cubics. So any SVG `<path>`,
plus the basic shapes (which are paths in disguise), converts losslessly. Fill,
stroke, and gradients map nearly 1:1 to style keys.

## Scope

**In (convert to native vectors):**

| SVG | How |
|---|---|
| `<path>` | d-string → op 0/1/3/5 command stream |
| `<rect>` (incl. `rx`/`ry`) | synthesized path |
| `<circle>`, `<ellipse>` | 4-cubic path |
| `<line>`, `<polyline>`, `<polygon>` | op 0/1 (+5 for polygon) |
| solid `fill` | style key 15 + alpha |
| `stroke`, `stroke-width` | keys 19, 22 |
| `<linearGradient>`, `<radialGradient>` | keys 60/61/62 (stops, angle) |
| nested groups, `transform` | flatten transforms into each shape's affine matrix |

**Out (fall back to PNG):** `<text>`, `<image>`, `<use>` of external refs,
patterns, masks, clip-paths, filters, `fill-rule="evenodd"` if it proves
unmappable, and any SVG whose external-resource pre-scan already trips today.
The converter returns `null` and the PNG path takes over.

## Behavior

Auto: on every paste/drop of an SVG, try `svgToSliceClip(svgText)` first.

- Returns a payload → deliver it via synthetic paste (the existing auto-place
  channel, extended to write the custom clipboard type into the `DataTransfer`).
  Toast: "SVG pasted as editable shapes".
- Returns `null` (unsupported feature encountered) → run the current
  `rasterizeSvg` → PNG pipeline unchanged. Toast: today's "SVG ready" / "placed".

No new UI, no toggle. One seamless behavior; vectors when we can, pixels when
we must.

## The converter (pure, testable)

`svgToSliceClip(svgText, { envelope }) → payloadObject | null`

Mirrors `rasterize.js`'s shape: pure function, no extension APIs, unit-tested in
the browser harness. Pipeline:

1. Parse with `DOMParser`; reject (→ null) on parse error or any out-of-scope
   element.
2. Walk the tree, accumulating `transform` matrices; convert each in-scope
   element to a shape command with a flattened affine matrix.
3. Map geometry to op 0/1/3/5 streams; map paint to style keys.
4. Resolve coordinates: SVG user units → Slides page units via a scale derived
   from `viewBox` (units look EMU-ish; exact factor pinned in the build).
5. Assemble `data` = `{resolved, unresolved, autotext_content, …}` with
   randomized shape IDs (forces Slides' parse path, per FINDINGS). `unresolved`
   = a clone of `resolved` (concrete colors — verified safe).
6. Wrap in a **template envelope** (captured; `dih`/`ds`/`cses`/`sm` are
   load-bearing). Ship the template in the repo; server keys `edrk`/`edi` are
   dropped.

Return `null` at the first unsupported feature — never emit a partial shape.

## Delivery

Extends the proven auto-place path. Today `autoPaste(blob)` posts a PNG into the
key-event iframe, which dispatches a synthetic `paste` with a `DataTransfer`
carrying `image/png`. For vectors we build a `DataTransfer` with
`setData('application/x-vnd.google-docs-drawings-object+wrapped', payload)` plus
the sibling `text/plain`/`text/html` flavors and dispatch the same way. Slides
accepts it despite `isTrusted:false` (proven). Success = `defaultPrevented`;
400ms timeout → fall back to writing the PNG to the clipboard.

## Testing

- **Unit (browser harness, like `test/tests.js`):** SVG fixtures → assert the
  produced `data` command stream. Cases: each basic shape, a multi-segment
  path, cubic + quadratic + arc commands, nested `transform`, solid fill/stroke,
  linear + radial gradient, and every out-of-scope feature → asserts `null`.
- **Golden replay (manual, `research/` harness):** the converter's output for a
  known SVG, replayed via Cmd+Shift+9, renders the expected shape and **syncs
  without the 400 banner** (server-model validity is the real bar, not just
  client render).
- **Regression:** unsupported SVGs still produce the correct PNG.

## Open questions (pin during build)

1. Exact SVG-unit → page-unit scale (derive from viewBox + a measured capture).
2. Does op 3 chain multiple cubics in one run, or one op per cubic?
3. Radial gradient center/radius/focal mapping (simple centered first).
4. Fill alpha / `fill-opacity` / `fill="none"` style-key encoding.
5. Whether a fabricated `dih` persists cross-session (template value works now).

## Non-goals (this iteration)

Text (Slides text-run machinery — deferred, likely never), images, filters,
animation, and reverse (Slides → SVG). Vector paste ships alongside the PNG
path, not replacing it.
