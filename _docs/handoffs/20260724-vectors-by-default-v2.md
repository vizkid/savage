# Handoff: Savage — Vectors by Default (v2) shipped

**From:** Savage v2 build session (main driver)
**To:** self (next session)
**Worktree:** /Users/viz/dev/savage
**Branch:** main
**Date:** 2026-07-24

## TL;DR
Savage v2 ("vectors by default") is complete, shipped, and fully pushed — all
paste flows deliver native editable Slides shapes, `<text>` converts to
curves, multi-shape pastes group, and the fill-rule/CSS/alpha edge cases from
real brand SVGs are handled. Nothing is blocking; next work is optional (Web
Store submission is still owner-gated, or await new problem SVGs).

## Next step
No pending build task. To validate a new SVG or reproduce the harness:
`dev-browser --headless` → open `file:///Users/viz/dev/savage/test/test.html`
→ read `window.__testResults` (expect 90/90). To convert an arbitrary SVG,
call `svgToSliceClip(svgText, {fetchFont})` (async) in that page context. If a
user reports an SVG rendering wrong, capture its per-shape nonzero-vs-evenodd
areas and render the output evenodd (that's how every v2 fix was verified).

## Big picture
Google Slides has no SVG import. Savage intercepts SVGs (drop, dragged URL,
copy→paste) and injects Slides' internal vector clipboard format
(`application/x-vnd.google-docs-drawings-object+wrapped`) so they arrive as
native, editable shapes — falling back to the original PNG rasterizer for
anything unconvertible. The converter is a pure function that **morphs a
shipped template capture** (from-scratch payload assembly crashes the editor)
and delivers via a synthetic paste event (the async clipboard API can't carry
custom MIME types). Slides fills freeforms **evenodd**, so the hard part is
normalizing SVG's nonzero-fill geometry (glyph outlines, keyhole counters,
union-idiom logos) into evenodd-safe rings via Clipper.

## Key code locations
- `vectorize.js` — `svgToSliceClip()`: parse → CSS cascade → per-element paint
  → geometry → nonzero/evenodd area check + Clipper normalize → template morph
  → group. The whole converter.
- `pathdata.js` — pure geometry: transform matrices, d-string parser
  (M/L/H/V/C/S/Q/T/A/Z → abs M/L/C/Z), arc→cubic, basic-shape synthesis.
- `fonts.js` — text-to-curves: @font-face/Google-Fonts/bundled-Roboto ladder,
  glyph outline → Clipper-normalized rings. `vendor/` has opentype/clipper/roboto.
- `content.js` (top frame) + `iframe-paste.js` (key-event iframe): triggers,
  stash protocol, Cmd+V vector interception, Cmd+Shift+V PNG hatch, delivery.
- `sw.js` — `fetch-font` (Google Fonts via legacy-UA DNR rule) + `fetch-svg`.
- `test/vectorize.tests.js` + `test/fonts.tests.js` — 90 contract tests;
  `test/harness.js` runner; `test/ACCEPTANCE.md` rows 1–32 (manual/live).

## Open questions / pending decisions
None blocking. `#7` (make the Cmd+Shift+V hatch PNG size-match the vectors)
was explicitly deferred by the owner — leave as-is unless asked.

## Verification snapshot
| Check | Status | Detail |
|---|---|---|
| Branch | main | |
| Uncommitted | clean | |
| Unpushed commits | 0 | all pushed through 01e03e4 |
| Submodule | n/a | none |
| Lint | n/a | no linter configured |
| Typecheck | n/a | plain JS, `node --check` clean on all 9 source files |
| Tests | pass | 90/90 (`test/test.html` via dev-browser headless) |
| Manifest | valid | |

## Commits this session (newest first; ALL pushed)
v2 arc:
| SHA | Subject |
|---|---|
| 01e03e4 | fix: honor fill-rule (and paint) inherited from root `<svg>` |
| bdf6ce7 | fix: normalize any nonzero path whose fill differs from evenodd (keyhole 'e') |
| c5ba383 | docs: close the v2 loop |
| 431a605 | feat: group multi-shape pastes into one object |
| b39c60e | fix: accurate overlap test + union normalization |
| d39308e | feat: CSS-class styling + resilient PNG fallback |
| 1e67deb | fix: union glyph outlines across the whole text run |
| 6f28c25 | fix: DNR UA rule must match 'other' resourceType |
| 8efd2d0 | fix: Google Fonts fetch — correct legacy UA |
| 2506f32 | feat: native translucent fills — style key 16 |
| 7e53414 | fix: normalize glyph outlines with Clipper |
| b69d0d9 | feat: vectors by default (Cmd+V, Cmd+Shift+V, text-to-curves) |
| c9d75fa | docs: VECTOR2 spec |

Earlier in the same session (v1 native vector paste): c9f0b73, 41a3d80,
272072f, b30ce40.

## WIP / uncommitted
Clean.

## Discoveries / gotchas
- **Slides fills freeforms evenodd, always.** Any nonzero SVG geometry whose
  fill differs from evenodd (glyph keyholes, self-intersections, same-winding
  overlapping subpaths / union-idiom logos) MUST be Clipper-normalized or it
  notches. Detect via **nonzero-filled area vs evenodd-filled area** of the
  same flattened contours — differ → normalize, equal → emit exact béziers.
  A pairwise-subpath overlap test is NOT enough (misses single-subpath keyholes).
- **Shape type 138 draws op-1 chains straight; 154 spline-smooths them.** Emit 138.
- **Style keys: 14 = fill on/off, 16 = fill opacity (0..1), 18 = stroke
  on/off (drops 19 when off).** Group command = **cmd 2**
  `[id, [childIds], [1,0,0,1,0,0], "p"]` appended after shapes; children keep
  `parent:"p"`.
- **Google Fonts css2 serves TTF only to a bare legacy UA** (`Mozilla/5.0
  (Windows NT 5.1)` — a Firefox-40 string still gets woff2, which opentype
  can't read). The DNR UA-rewrite rule MUST match resourceType **`other`** (MV3
  service-worker fetch is not `xmlhttprequest`).
- **Extension reload orphans the content script** in open Slides tabs —
  `chrome.runtime` goes undefined until the TAB is reloaded (postMessage paths
  keep working, so it's easy to misdiagnose). Reload the tab, not just the ext.
- **Serif/Affinity exports put `fill-rule:evenodd` on the root `<svg>`** and
  style fills via `<style>` class rules — both now honored (root inheritance +
  CSS cascade).
- **Color/white-border brand icons embed raster `<image>` data** (baked
  bitmap), so they correctly PNG-fallback; only black/white/text variants are
  true vectors. Not a bug.
- Live spikes need viz's REAL Chrome (login + clipboard perms are profile-bound;
  `dev-browser --headless` is only for the unit suite + render screenshots).
  Cmd+Shift+9 golden replay needs the `savage-vector-spike` unpacked extension.

## Deferred / in-flight
- **Web Store submission** — still owner-gated ($5 reg + upload); listing kit
  in `store/`, privacy policy live. Consider a real paste screenshot for the hero.
- **#7 hatch PNG size-match** — deferred by owner.
- Brand color-icon variants → editable vectors would need re-export without the
  embedded bitmap (export-side, not converter).
- User pref: no em dashes / AI-tell vocabulary in copy; dry humor; regular-case
  "Savage".

## References
- Specs: `VECTOR2-SPEC.md` (v2, shipped @ 431a605), `VECTOR-SPEC.md` (v1),
  `SPEC.md` (extension), `research/FINDINGS.md` (clipboard format).
- Repo: https://github.com/vizkid/savage — Pages: https://vizkid.github.io/savage/
- Memory: `google-slides-extension-internals.md` (Slides facts + v2 internals),
  `savage-dih-envelope-staleness.md` (template-morph design rationale).
- Commits: b30ce40..01e03e4 (this session); v2 arc c9d75fa..01e03e4.
