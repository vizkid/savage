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
patterns, masks, clip-paths, filters, partial opacity (`opacity`/
`fill-opacity`/`stroke-opacity` ≠ 1, rgba colors), off-center radial
gradients, nonzero-rule paths whose same-winding subpaths overlap (Slides
fills evenodd), and any SVG whose external-resource pre-scan already trips
today. The converter returns `null` and the PNG path takes over.

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

`svgToSliceClip(svgText) → flavors | null` (flavors = `{type: string}` map
ready for `DataTransfer.setData`, same shape as a capture dump)

Mirrors `rasterize.js`'s shape: pure function, no extension APIs, unit-tested
in the browser harness.

**Strategy: template morph, not assembly** (pivoted 2026-07-23, probes L/M).
Fully-synthetic payloads crash the editor for unknown reasons; morphing a real
captured dump in place is proven across every probe. The repo ships one
sanitized capture (a single freeform shape: envelope + data skeleton + html
flavor, ids/guid randomization applied at paste time, `clip-id`/`edrk`/`edi`
stripped — cross-deck validity proven). Pipeline:

1. Parse with `DOMParser`; reject (→ null) on parse error or any out-of-scope
   element.
2. Walk the tree, accumulating `transform` matrices; flatten each in-scope
   element to an absolute path (transforms baked into coordinates).
3. Map geometry to op 0/1/3/5 streams (op-3 runs may chain 2n cubic coords —
   proven); scale SVG user units × **381 units/CSS px** (36576/inch); shape
   transform is `[1,0,0,1,tx,ty]` with keys 8/9 = the shape's path bbox.
4. Map paint to style keys: 15/19/22 colors + weight, 14:0 fill-off, 18:0
   stroke-off (drop 19), 60/61/62 (+73/145) gradients.
5. Morph the template: clone its shape command per SVG element (fresh ids,
   same id in `resolved` + `unresolved`), patch **type → 138** (154
   spline-smooths op-1 chains), swap geometry + paint keys in place.
6. Emit the template's flavor set with fresh ids/guid every call.

Return `null` at the first unsupported feature — never emit a partial shape.
Fill rule: Slides fills freeforms **evenodd** (winding-independent). SVG
evenodd maps natively; a nonzero SVG whose same-winding subpaths overlap
(union idiom) would mis-render — detect via signed-area winding + bbox
overlap and return null.

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

## Open questions — all resolved (probes 2026-07-23, see research/FINDINGS.md)

1. Scale: **381 units/CSS px = 36576/inch** (= EMU/25), pinned three ways.
2. op 3 **chains** (one run, 2n coords) — and one-per-op also works.
3. Radial gradient center/focal: still unprobed → simple centered radials
   only; off-center radials → PNG fallback.
4. `fill="none"` → key 14:0; stroke none → 18:0 + drop 19. Partial alpha
   (`fill-opacity` ≠ 0/1, rgba) never probed → PNG fallback this iteration.
5. Envelope: staleness debunked; the shipped template's `dih` works
   **cross-deck** into brand-new decks. (From-scratch assembly, however,
   crashes the editor — hence the template-morph design.)

## Non-goals (this iteration)

Text (Slides text-run machinery — deferred, likely never), images, filters,
animation, and reverse (Slides → SVG). Vector paste ships alongside the PNG
path, not replacing it.
