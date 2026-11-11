# Savage: Vectors by Default (spec)

**Owner:** viz · **Last updated:** 2026-11-12 · **Status:** shipped (main @ 431a605); outline clips + packed arc flags added 2026-11-12
**Lineage:** extends the shipped `VECTOR-SPEC.md` (v1: drop/URL flow, no text)

## Shipped state (what actually landed)

All four planned milestones plus fixes surfaced during live acceptance:

| Area | Shipped |
|---|---|
| All flows | Drop, URL, **and** copy→Cmd+V (trusted-paste interception in `iframe-paste.js`) deliver vectors |
| Cmd+Shift+V | Delivers the PNG when the clipboard holds a Savage-converted SVG; mismatch → native paste-without-formatting |
| Text → curves | Embedded `@font-face` → Google Fonts (css2 + legacy-UA DNR rule, resourceType `other`) → bundled Roboto. Glyph outlines normalized nonzero→evenodd via Clipper (whole run, so connecting scripts don't notch) |
| **CSS styling** *(added)* | `<style>` class/type selectors with the full cascade (presentation < type < class < inline) — Illustrator/Figma/logo exports now convert |
| **Fill alpha** *(added)* | `fill-opacity`/`opacity`/rgba → style key 16 (native translucent fills) |
| **Grouping** *(added)* | Every paste wrapped in one group (cmd 2) so it drags/scales/selects as a unit |
| **Connector anchor** *(added)* | A transparent type-6 preset rect covering the bbox is grouped behind the artwork — freeforms have no connection sites, so this makes the paste snap to diagram connectors |
| Fill rule | Genuine same-winding overlaps (real intersection test, not bbox) unioned via Clipper; only stroked union-idiom paths → PNG |
| PNG fallback | Rasterize + synthetic auto-place decoupled from the clipboard write, so a blocked write never hard-errors |

Vendored: opentype.js (MIT), clipper-lib (Boost), Roboto Regular (Apache) —
`vendor/LICENSES.md`. Unit suite 110/110 (2026-11-12); live acceptance rows 19–33.
Clipper geometry (fill normalization, clip regions) lives in `vecgeom.js`.
`#7` (size-match the hatch PNG) intentionally left as-is per owner.

## Problem / solution

v1 delivers native shapes only on the drop/URL flow, punts `<text>` to PNG,
and gives the user no recourse when a conversion is imperfect — the converter
decides, silently. This iteration makes vectors the default everywhere:

1. **All flows** — the copy → Cmd+V clipboard flow joins drop/URL via
   trusted-paste interception.
2. **Text converts** — glyphs become outlined curves (Illustrator's
   "outline text" trade: scalable and recolorable, no longer editable as text).
3. **Escape hatch** — a shortcut re-pastes the last conversion as PNG when
   the vectors look wrong. User control beats silent heuristics at the margin.

## Core insight

**Glyphs are just paths.** The path pipeline is fully proven (opcodes →
server sync), so text support is not a format problem — it is only a
get-the-outlines problem: parse the font file, ask it for glyph paths, feed
the existing segment emitter.

## Scope

| Piece | In | Out (→ PNG fallback) |
|---|---|---|
| Flows | drop, dragged URL, copied-SVG Cmd+V | — |
| Text | single-line `<text>` with direct content; `x`/`y`, `text-anchor`, `font-family/size/weight` (weight → nearest available face), fill/stroke paint | `<tspan>`, `textPath`, `dx`/`dy`, `letter-spacing`, `writing-mode`, non-alphabetic `dominant-baseline`, RTL/complex scripts |
| Fonts | `@font-face` data-URI in the SVG (exact); Google Fonts fetch by family (optional host permission); bundled fallback face | any font we can't obtain **and** whose family isn't close to the fallback — reject rather than mis-render? No: fallback face renders, PNG only if no face at all |
| Everything else | unchanged from v1 | unchanged from v1 |

Bundled face: **Roboto Regular** (Apache 2.0, bundle-safe, the Google-ecosystem
default so most Slides-adjacent SVGs look native in it). One face in v2;
weight/italic mapping can add faces later.

## Text → curves pipeline

1. Resolve the face: embedded data-URI → parse; else family name → Google
   Fonts fetch via `sw.js` (`fetch-font` message; css2 API with a legacy
   user-agent so it serves TTF, since opentype-class parsers don't read
   woff2); else bundled Roboto. No face → PNG.
2. `font.getPath(text, 0, 0, fontSize)` with kerning → segment list (paths
   are paths from here down).
3. `text-anchor` offsets by measured advance width (start/middle/end).
4. Paint applies exactly like any other shape (fill/stroke style keys).

Library: an opentype.js-class parser, vendored (~130KB). Licensing: MIT.

## Cmd+V flow (trusted-paste interception)

`checkClipboard` already rewrites clipboard SVGs to PNG + preserved
`text/plain`. It additionally stashes `svgToSliceClip`'s payload. The
key-event iframe adds a **capture-phase listener on trusted paste events**:
if `e.clipboardData.getData('text/plain')` equals the stashed source SVG,
`preventDefault` + dispatch the synthetic vector paste instead. Any mismatch,
no stash, or vector-null → native flow untouched. The stash clears on use and
on clipboard rewrite, so stale intercepts are impossible.

## Escape hatch: Cmd+Shift+V pastes the PNG

**`Cmd/Ctrl+Shift+V` (native paste-without-formatting) delivers the PNG when
the clipboard holds a Savage-converted SVG.** Paste-without-formatting is
meaningless for an SVG paste anyway — "unformatted version" *is* the raster.
The shortcut keeps its native behavior for all other clipboard content.

Mechanism (safe against races by construction):

1. Every conversion — drop, URL, or clipboard — writes the clipboard with
   `image/png` + the source SVG as `text/plain` (v1's vector drop path skips
   this; v2 restores it) and stashes `{svgText, pngBlob}` in memory.
2. The key-event iframe captures `Cmd/Ctrl+Shift+V` keydown. Stash present →
   `preventDefault` synchronously, then verify async: clipboard `text/plain`
   equals the stashed `svgText` → dispatch the synthetic **PNG** paste
   (toast: "Pasted as PNG").
3. Verification mismatch (user copied something else since) → dispatch a
   synthetic `text/plain`-only paste of the actual clipboard text —
   functionally identical to native paste-without-formatting, so the native
   contract holds even though we swallowed the keydown.
4. No stash at all → the keydown passes through untouched.

Worked example: drop an SVG → a gradient looks off → `Cmd+Z` →
`Cmd+Shift+V` → the same SVG lands as PNG.

No sticky "always PNG" mode: a forgotten global toggle would silently disable
the feature; the shortcut keeps intent local to one paste.

## Testing

- **Unit:** build a tiny 2–3 glyph font *in the harness* with the vendored
  library, embed it as a data-URI fixture → assert exact outline op streams,
  anchor offsets, and fallback behavior (missing face → null). Interception
  and escape-hatch logic get pure-function tests where extractable.
- **Golden replay:** a text-bearing SVG through the converter → Cmd+Shift+9 →
  renders, syncs, survives reload.
- **Acceptance additions:** copied SVG Cmd+V lands vectors; mismatched
  clipboard falls through natively; escape-hatch chord re-pastes as PNG;
  Google-Fonts text converts with permission granted and falls back without.

## Milestones (each independently shippable)

1. **M1 — all flows:** trusted-paste interception, no text changes.
2. **M2 — text, local faces:** embedded data-URI + bundled Roboto.
3. **M3 — Google Fonts fetch** behind the optional host permission.
4. **M4 — Cmd+Shift+V PNG paste** (independent of the others; can land first).

## Risks / open questions

1. TTF-via-legacy-UA on the Fonts API is a hack Google could close; M3
   degrades to bundled-face behavior if it breaks.
2. Kerning quality: parser-level kern/GPOS pairs only, no full shaping —
   acceptable for Latin UI text, and PNG fallback remains for the rest.
3. Both interceptions (Cmd+V vector swap, Cmd+Shift+V PNG) must provably
   never eat an unrelated paste — the stash-match + mismatch-passthrough
   design guarantees it; tests must prove it, including the async-verify
   fallback path (step 3 above).

## Clip paths that remove nothing

Exporters often wrap artwork in a clip that cuts nothing. Figma and Atlassian
use a frame rectangle. Illustrator PDF exports use the artwork's own outline,
often through `<use>` (the Barclays logo clips its eagle to a shield path).
**A clip-path is ignored when the clipped content lies inside the clip
region. Otherwise the SVG falls back to PNG.**

| Piece | Rule |
|---|---|
| Clip region | Union of the `<clipPath>` children: `rect`, `circle`, `ellipse`, `polygon`, `polyline`, `path`, and `<use>` that points by `#id` at one of those in the same file. Child `transform`, the `<use>` `x`/`y`, and `clip-rule` apply. |
| Containment | Clipper difference of the content's flattened outline minus the clip region (grown by 2 CSS px for curve-flattening slack). Stroked shapes are grown by half the stroke width first. Any remaining area → PNG. |
| `<use>` | Allowed only inside `<clipPath>`. Anywhere else it still forces PNG. |
| PNG fallback | `clipPathUnits="objectBoundingBox"`, a clip child we cannot turn into an outline, or content that crosses the clip edge. |

## Path data and viewBox

Arc flags are single characters and may be packed without separators, as
minifiers emit them: `a5 5 0 01-.6.04` means flags `0`, `1`, then `x = -.6`.
The parser reads each flag as one `0` or `1` character.

The root `<svg>` fits its viewBox into `width`/`height` the way a browser
does, through the same code as a nested `<svg>`. `preserveAspectRatio`
defaults to `xMidYMid meet`, so the artwork keeps its aspect. Only `none`
stretches per axis. `slice` crops the overflow, so it falls back to PNG.
Example: the Barclays logo declares `width="1200" height="800"` over a 5:1
viewBox and pastes at 5:1.

## Deferred

**Cropping clip-paths** (clips that actually cut geometry, vs. the no-op
clips described above). Deferred 2026-07-28 — PNG fallback is fine for now.
When it matters: Slides' native masking is **image-only** (no live vector-group
mask in the UI or the cracked clipboard format), so the path is to **bake the
clip geometrically** — flatten the clip region to a polygon and Clipper-
intersect each filled shape with it, emitting the clipped freeforms (we already
ship Clipper). The clip is permanent, not a live mask. Fall back to PNG for
clipped shapes with a visible stroke (needs stroke-outlining) or a clip region
that can't be flattened.

## Non-goals

Native editable Slides text, multi-line/flowed text, complex shaping (Arabic,
Indic), variable fonts, `<tspan>` positioning, sticky PNG mode.
