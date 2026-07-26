# Vector clipboard format: findings

Established empirically 2026-07-23, in a live Slides session. Status: format
cracked; converter is buildable.

## Delivery (proven)

Synthetic `ClipboardEvent('paste')` with `DataTransfer.setData()` carrying
`application/x-vnd.google-docs-drawings-object+wrapped` inserts native,
editable vector shapes. `isTrusted: false` is not checked. The async clipboard
API can neither read nor write this type; the synthetic-paste channel is the
only delivery mechanism, and Savage already ships it.

## Lookup-before-parse (the trap that cost a day)

Slides tries hard to NOT parse the payload. In priority order it will:

1. Use the session cache keyed by `application/x-vnd.google-docs-internal-clip-id`.
2. Clone an existing shape when pasting into the source document with the
   original shape ids.
3. (Suspected) match the `docs-internal-guid-…` in the text/html flavor.

Only when every lookup fails does it parse `data`. Generated payloads contain
none of these keys, so they always hit the parse path. Confirmed: a payload
with randomized shape ids, randomized guid, no clip-id, and no `edrk`/`edi`
server keys renders exactly the geometry in `data` (mutation visibly applied).

## Envelope

```json
{ "dih": <int>, "data": "<json string>", "dct": "punch", "ds": false, "cses": false, "sm": "other" }
```

- `edrk`/`edi` (server resource keys): safe to omit.
- `dih`: per-document integer (same for all copies from one deck). Untested
  whether it can be omitted or faked; test before speccing the converter.
- `dct: "punch"` = Slides ("punch" is Slides' internal codename).

## data schema (positional command arrays)

`{"resolved": [...], "unresolved": [...], "autotext_content": {...}, ...}`.
`unresolved` is the theme-reference variant (colors as `[null, N]` theme
slots, parent = source page id); `resolved` uses concrete values and parent
`"p"`. Setting `unresolved` = `resolved` with concrete colors: untested but
the parse run kept both lists mutated and rendered fine.

Commands seen:

- `[3, id, shapeType, [a,b,c,d,tx,ty], [styleKey, value, ...], parent]` — create
  shape. `shapeType`: preset enum (6, 59, …) or **154 = freeform path**.
  Transform is an affine matrix; tx/ty in EMU-ish page units.
- `[2, id, [childIds], [affine], parent]` — group. **Pinned 2026-07-23** (dump
  p-group): to group N shapes, append ONE cmd 2 after the shape commands with
  every child id, identity affine `[1,0,0,1,0,0]`, parent `"p"`. Children are
  UNCHANGED — they keep `parent:"p"`; the hierarchy lives only in the group's
  child-id list. No style, no cmd-17 companion. Verified: injecting this makes
  a multi-shape paste select/drag/scale as one object and syncs.

**Connection sites (diagram connectors), pinned 2026-07-26** (dump p-connector):
freeform shapes (type 138) have NO connection sites, so diagram connectors
can't snap to them. **Type-6 preset rectangles DO.** To make a paste
connectable, prepend a transparent type-6 rect covering the union bounding box
and include it in the group. The rect: `[3, id, 6, [W/120000,0,0,H/120000,x,y],
[14,0, 15,"#FFFFFF", 18,0, 22,381, 60,0], "p"]` (14:0 fill-off, 18:0
stroke-off = invisible) plus its cmd-17 companion `[17, id, null, 0, 1, [],
[12, 2]]` (type-6 presets carry the tail; freeforms don't). Preset size comes
from the transform on the 120000-unit unit square. Verified: connectors snap
to the grouped node and it syncs.
- `[17, id, null, 0, 1, [], [12, 2]]` — accompanies shapes; role unknown;
  copying it verbatim works.

Style keys observed:

| key | meaning |
|---|---|
| 8, 9 | path-space width, height (freeforms) |
| 12 | path data (freeforms): `[[1, 1, [ops], [coords], [], 0]]` |
| 14 | unknown (1 on freeforms/gradient shape) |
| 15 | fill color `"#RRGGBB"` |
| 19 | stroke color |
| 22 | stroke weight (381 for default 1px-ish) |
| 25, 27, 30 | unknown (freeforms: 0, 1.3, 1.3) |
| 60 | gradient type: 1 = linear, 2 = radial |
| 61 | gradient stops: `[[ "#RRGGBB", offset0to1 ], ...]` (any count; = SVG stops) |
| 62 | gradient angle, radians (1.5708 = π/2 = 90°) |
| 73 | radial-only flag (1) |
| 145 | "has gradient fill" marker (1) |

Gradients map ~1:1 to SVG: `<linearGradient>`/`<radialGradient>` stop list →
key 61, angle → 62, type → 60. Verified with real linear + radial dumps
2026-07-23. Radial center/radius/focal (SVG cx/cy/r/fx/fy) not yet
distinguished — spec should map simple centered radials first.

Path ops (stream of `op, coordCount` pairs over a flat coord array). Pinned
2026-07-23 by crafting single-op shapes and replaying (experiment C):

| op | coords | meaning | syncs |
|---|---|---|---|
| 0 | 2 | moveTo | yes |
| 1 | 2n | polyline: straight lines through n points | yes |
| 3 | 6 | **cubicTo: 2 control points + endpoint (SVG `C`)** | yes |
| 5 | 0 | closePath | yes |
| 2, 4 | — | also render curves but the doc fails server save (400); wrong coord grammar, ignore | **no** |
| 6, 7 | — | unknown opcodes, silently ignored (no-op, no crash) | n/a |

**Complete SVG path coverage:** M→0, L→1, C→3, Z→5. Q decomposes to one cubic,
A (elliptical arc) to a few cubics — so op 0/1/3/5 render any SVG path. op 1
with `smooth` style key (14) = 0 is straight; the freeform captures with 14=1
were Slides' own spline-smoothing of hand-drawn points, not needed for
conversion (we emit explicit cubics via op 3).

Fallback if exact cubics ever misbehave: flatten every SVG curve to short op-1
line segments. Always syncs, visually indistinguishable at slide scale.

## Coordinate space (pinned 2026-07-23, probes P1a/P1b)

**36576 units per inch = 381 units per CSS px** (= EMU/25; explains the
default stroke weight 381 = exactly 1px). Confirmed three independent ways
from a 2"×1" rect at (1", 0.5") and a 1"×1" freeform:

- Preset shapes sit on a **120000-unit unit square**; the transform scales it:
  `a = widthUnits/120000` (0.6096 = 2×36576/120000), `d = heightUnits/120000`.
- `ty` = 18288 = 0.5 × 36576 exactly.
- Freeform on-page size = keys 8/9 × transform scale = 36576 (1") on both axes.

Freeform path coords are in the **same units**: keys 8/9 are the path bounding
box, the transform maps path space → page. Identity transform + pre-scaled
coords is proven (all crafted experiment shapes), so the converter can emit
`[1,0,0,1,tx,ty]` and multiply every coordinate by SCALE = 381/CSS-px.

Anomaly, not blocking: panel X = 1" stored `tx` 36442 (−134) on two different
shapes, while every size and Y reading was exact. We position pasted shapes
ourselves, so irrelevant to the converter.

## Fill/stroke flags (pinned 2026-07-23, probes P3 — corrects the table above)

- **Key 14 = fill on/off, not smoothing**: absent = default (on), `0` =
  transparent fill, `1` = explicitly filled. The freeform captures' 14:1 was
  fill-on; earlier "spline smoothing" reading was wrong. Crafted shapes with
  14:0 rendered as outlines because their fill was off.
- **Key 18 = stroke on/off**: absent = on, `0` = transparent stroke — and the
  stroke color key 19 disappears entirely when off.
- Fill color (15) persists even when fill is off. Default-styled shapes omit
  14/18/60 altogether.
- **Key 16 = fill opacity** (0..1): pinned 2026-07-23 evening — a 50%
  fill-transparency rect dumps `16: 0.5` (and the earlier custom-fill capture's
  `16: 1` was simply "fully opaque"). Optional; absent = opaque. Stroke-alpha
  and gradient-stop-alpha keys remain unprobed.
- Key 60 `0` = explicitly no gradient.

## Shape type is (very likely) the op-1 interpreter switch — UNVERIFIED, test first

With key 14 reclassified as fill (P3), the original question is reopened: what
made op-1 chains render *smooth* in the curve captures but *straight* in the
polyline capture, when the op streams are identical? The remaining
differentiator is the shape type: **154 (curve captures, smoothed) vs 138
(polyline capture, straight)**. Hypothesis: type 154 spline-smooths op-1
anchor chains; type 138 draws them straight.

Supporting evidence from the first crafted-payload session (chat-only until
now — this was the missing learning):

- The single fully-synthetic shape that ever rendered (experiment b-envelope)
  was a **type 154** op-1 square, open path — and it rendered as a *distorted
  semicircular blob*, then the editor crashed. A spline through a square's 4
  anchors is exactly that blob. The distortion was misattributed to data
  corruption at the time.
- Every sync-clean crafted shape (the entire c-* series, including the op
  hunt) inherited **type 138** from the real polyline dump. Corners stayed
  corners.
- The c-type probe (real polyline data, type flipped 138→154) "worked" but
  nobody checked whether it rendered smoothed — consistent with the
  hypothesis, not against it.

**Consequences for crafting:** emit type 138 for all line/cubic work until an
A/B probe (same op-1 square, once as 138 once as 154) settles it. `craft.js`'s
`shape()` previously defaulted to 154 — experiments D/E/F built on that
default would produce smoothed blobs instead of clean squares/donuts, which
reads as "synthetic shapes come out wrong." Default now flipped to 138.
Note op 3 cubics rendered + synced on a 138 template (c-op3); op 3 under 154
is untested.

## From-scratch synthesis: current record (honest version)

No fully-synthetic payload has ever been proven sync-clean. The record:

- bare envelope + synthetic data → silently dropped (exp A, b-minimal)
- real envelope + synthetic data (type 154) → rendered distorted, then the
  editor crashed with an error dialog (b-envelope) — now attributed to the
  type-154 smoothing above, not to the data assembly itself
- real dump morphed (ids/guid randomized, keys stripped, geometry/style
  swapped in place) → renders and syncs, every time (c-* series)

So "synthesis is broken" was never established — it was only ever tested
wearing type 154. Experiment F (single synthetic square, real envelope graft)
should be re-run with type 138 before concluding the converter must morph a
template rather than assemble.

## Morph-recipe probes (experiment M, 2026-07-23 afternoon — build gates, all green)

The from-scratch `payload()` skeleton crashes the editor even with type 138
(f-solo) — cause unknown, not worth chasing. **The converter design is
template morph**: take a real captured dump, randomize ids, strip
clip-id/edrk/edi, swap geometry + style in place (the c-series recipe,
re-validated today as L1/L2). On that foundation:

| probe | result |
|---|---|
| m-multi | **Multi-shape works**: shape command duplicated with fresh id → two shapes, one paste, syncs. The cmd-17 tail is optional (freeform dumps carry none). |
| m-multi | **Type patch 154→138 works**: straight sides. L2 (type kept 154) drew the same op-1 square with curved sides → 154 spline-smooths op-1 chains, 138 draws straight. Smoothing hypothesis CONFIRMED (f-solo's crash was unrelated). |
| m-chain | **op 3 chains**: one run, 12 coords = two cubics, renders + syncs. Emitter can chain all cubics in a single run. |
| m-donut | **Multi-subpath works**: two subpaths in one path stream, opposite winding → hole, fill + stroke correct. |
| m-donut-same | **Fill rule is evenodd**: same-winding inner subpath also punches a hole (winding-independent). |

Fill-rule consequence: SVG `fill-rule="evenodd"` maps natively. Default
(nonzero) SVGs match evenodd except same-winding *overlapping* subpaths used
as unions — converter should detect (signed-area winding + bbox overlap
heuristic) and fall back to PNG for that rare case.

Envelope staleness: **debunked**. L1 replayed an hour-old dump clean, and real
cross-account pastes work at any age. The earlier "goes stale" note came from
runs whose real failure was type-154 smoothing / synthetic-skeleton crashes.
**Cross-deck: proven.** A morphed payload (template from deck A, including its
`dih`) pastes into a brand-new deck B and syncs. A static shipped template
envelope is viable. Reload check also passed: every experiment-M paste
survived, so the whole morph recipe is server-valid.

## Resolved during the spike

1. lineTo = op 1 (straight chain). ✓
2. cubicTo = op 3, 6 coords, syncs. ✓
3. `unresolved` = `resolved` (concrete colors) parses fine. ✓ (experiment c-unres)
4. Envelope fields (`dih`, `ds`, `cses`, `sm`) are load-bearing — a bare
   `{data, dct}` envelope silently drops; copying a template envelope works.
   The synthetic control shape only rendered once wearing the real envelope.

## Open questions before the converter spec

1. `dih`: template value works (copied from a real dump). Untested whether a
   fabricated one persists across sessions — spec should ship a captured
   template envelope and revisit only if pastes fail on other machines.
2. Does op 3 chain (multiple cubics in one op run) or is it one-cubic-per-op?
   Nail during the build with the replay harness.
3. Fill/stroke edge cases: none/transparent (SVG `fill="none"`), opacity,
   stroke width scaling, stroke dash.
4. Multi-subpath SVGs (multiple `M` in one path) and fill-rule.
5. Coordinate space: page units look like EMU-ish; derive the SVG→units scale
   from viewBox during the build.

## Tools

- `dump.html`: captures flavors, auto-mutates (coord + fresh ids + fresh
  guid), optional stripping, puts replay text on the clipboard.
- `spike-vector/`: Cmd/Ctrl+Shift+9 in Slides replays the dump JSON on the
  clipboard via synthetic paste.
