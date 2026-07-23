# Pre-build probes (P1–P4)

Answers the spec's open questions before `vectorize.js` is written. Everything
runs in viz's real Chrome (login + clipboard permissions are profile-bound).
Dumps land in `~/Downloads/savage-clip-dump-*.json`; move or copy them to
`research/dumps/` (gitignored — they carry doc-identifying server keys).

Setup once: open a scratch Slides deck and `research/dump.html` in tabs.
For replays, the spike extension (`research/spike-vector/`) must be loaded.

## P1a — page-unit scale (capture)

1. In the deck: Insert → Shape → Shapes → Rectangle, draw it anywhere.
2. Format options → Size & Position: Width **2**, Height **1** (inches),
   Position X **1**, Y **0.5** (from top-left).
3. Select the shape, Cmd+C. Click the dump tab, Cmd+V.
4. Save the downloaded JSON as `research/dumps/p1a-rect-2x1in.json`.

Read: transform `tx,ty` vs. (1", 0.5") pins page units per inch (hypothesis:
EMU, 914400/in). The matrix `a,d` or keys 8/9 vs. 2"×1" pins how preset size
is encoded. This dump is also the envelope source for the crafted replays.

## P1b — freeform path-space scale (capture)

1. Insert → Line → Curve; click a few points, double-click to finish.
2. Note its exact Width/Height from Size & Position (any value, e.g. 1.53").
3. Cmd+C, dump-tab Cmd+V, save as `research/dumps/p1b-freeform.json`.
   Write the noted W×H into a note or tell the session.

Read: keys 8/9 vs. the noted inches — same unit as page space, or normalized?

## P3 — transparent fill / border (capture)

1. Duplicate the P1a rectangle. Fill color → **Transparent**. Cmd+C, dump,
   save as `research/dumps/p3-fill-none.json`.
2. Set Fill back to a color, Border color → **Transparent**. Cmd+C, dump,
   save as `research/dumps/p3-stroke-none.json`.

Read: how keys 15/19 encode "none" (absent? sentinel value?).

## P2 — op-3 chaining (crafted replay)

Generate: `node research/craft.js d-chain research/dumps/d-chain.json research/dumps/p1a-rect-2x1in.json`

1. Copy the payload file's text onto the clipboard
   (`pbcopy < research/dumps/d-chain.json`).
2. Focus the Slides deck, press **Cmd+Shift+9**.
3. Expect three shapes: control square, S-wave (one cubic per op), S-wave
   (single chained op run). Report which rendered and whether they match.
4. Wait ~10 s, watch for the red "can't sync" banner; then reload the deck —
   surviving shapes were accepted by the server.

Read: chained identical to per-op + survives reload → op 3 chains (2n coords).
Otherwise → emit exactly one cubic per op-3 run.

## P4 — multi-subpath + fill rule (crafted replay)

Generate: `node research/craft.js e-donut research/dumps/e-donut.json research/dumps/p1a-rect-2x1in.json`

Same replay steps. Expect three shapes: donut with opposite-winding hole,
same-winding donut, two disjoint squares in one path.

Read: only opposite-winding holed → nonzero rule. Both holed → evenodd.
Nothing / 400 → multi-subpath out of scope (PNG fallback for multi-`M` SVGs).

## Results

Recorded in `research/FINDINGS.md` as each probe lands.
