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
- `[2, id, [childIds], [affine], parent]` — group.
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
