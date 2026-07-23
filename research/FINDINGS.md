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
| 60, 61 | gradient: type, `[[color, position], ...]` stops |
| 73, 145 | unknown (gradient dump) |

Path ops (stream of `op, coordCount` pairs over a flat coord array):

- `0` = moveTo (2 coords)
- `1` = curve chain (coord count varies: 10, 12, 14 observed; NOT always a
  multiple of 6, so semantics are not plain cubics; needs pinning)
- `5` = closePath (0 coords)
- lineTo opcode: not yet observed (need a polyline capture)

## Open questions before the converter spec

1. lineTo opcode (capture a Polyline).
2. Exact op-1 semantics (craft payloads with hand-built coord streams and see
   what renders; replay is now a test harness we control).
3. Whether a raw cubic-bezier opcode exists (SVG conversion wants exact
   cubics, not smoothed splines).
4. Can `dih` be omitted/faked in generated payloads?
5. Does `unresolved` = `resolved` (all concrete colors) parse?
6. Fill/stroke edge cases: none/transparent, opacity, stroke dash.

## Tools

- `dump.html`: captures flavors, auto-mutates (coord + fresh ids + fresh
  guid), optional stripping, puts replay text on the clipboard.
- `spike-vector/`: Cmd/Ctrl+Shift+9 in Slides replays the dump JSON on the
  clipboard via synthetic paste.
