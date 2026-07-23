# Savage: Convert SVGs to PNGs for Google Slides (MVP Spec)

**Owner:** viz · **Last updated:** 2026-07-22 · **Status:** built and accepted (paste, drop, auto-place, config panel all verified live); doc reflects as-built behavior

Chrome extension (MV3, unpacked). When the user copies an SVG anywhere and pastes into Google Slides, or drags an SVG into a slide, they get a high-resolution transparent PNG instead of a failed paste/drop. No UI, no options, no accounts. It does one thing.

## Problem

Google Slides has no SVG support. Pasting SVG markup dumps raw text into a text box; pasting an SVG image fails silently. Slides *does* accept `image/png` from the clipboard natively. So the fix is a clipboard rewrite: detect SVG on the clipboard when the user is in Slides, replace it with a rendered PNG, and let Slides' own paste handling do the rest.

## Product contract

1. User copies an SVG from anywhere: SVG markup as text (from an editor, devtools, Figma's "Copy as SVG"), or an `image/svg+xml` clipboard item.
2. User switches to a Google Slides tab.
3. Extension detects the SVG, renders it to a transparent PNG (2048px longest side), and rewrites the clipboard.
4. A small toast appears: "SVG ready. Paste as PNG".
5. User presses Ctrl/Cmd+V. Slides pastes the PNG natively.

**Drop flow:**

1. User drags an SVG into the Slides editor: a `.svg` file from their file manager, an SVG image from another web page, or selected SVG markup.
2. Extension cancels the native drop (which would otherwise fail with "unsupported image type"), converts to PNG, puts the PNG on the clipboard, and dispatches a synthetic `paste` event carrying the PNG into Slides' key-event iframe.
3. Slides accepts the untrusted event (verified 2026-07-22) and places the image immediately, with no keypress. Toast: "SVG placed".
4. Fallback: if Slides ever starts ignoring synthetic paste (detected via `defaultPrevented`), the toast reads "SVG converted. Press Ctrl/Cmd+V to place it" and the clipboard path takes over.

That's the whole product. If the clipboard or drop has no SVG, the extension does nothing and stays invisible.

## Non-goals (MVP)

- ~~No vector/native-shape paste.~~ *(Shipped 2026-07-23: dropped/URL SVGs in scope convert to native editable shapes, PNG otherwise; see `VECTOR-SPEC.md`. The copy→Cmd+V flow still delivers PNG.)*
- No support for Docs, Sheets, or Drawings. Slides only.
- No onboarding, accounts, or analytics. UI is the toast plus one config panel: a toolbar popup with a single "output px" field (added to MVP scope 2026-07-22 at owner's request).
- No support for `.svg` files *copied* from Finder/Explorer (the async clipboard API cannot read arbitrary files). Dragging that same file in works instead; say so in the README.
- No drop-at-*cursor* placement. Dropped SVGs auto-place via a synthetic paste (Slides accepts untrusted paste events, prototyped and confirmed during acceptance), which lands at Slides' default paste position, not the exact drop coordinates.
- ~~No Chrome Web Store packaging.~~ *(Scoped in 2026-07-22: store submission kit lives in `store/`; see [Store packaging](#store-packaging). Unpacked loading still works.)*
- No Firefox/Safari.

## Architecture

```
savage/
├── manifest.json      MV3 manifest
├── config.js          DEFAULT_OUTPUT_PX = 2048 + getOutputPx() (chrome.storage.sync)
├── popup.html/js      config panel: one number input for output px (longest side)
├── content.js         paste + drop triggers, clipboard read/write, toast
├── rasterize.js       SVG text → PNG blob (pure function, testable) + detection helpers
├── sw.js              service worker: cross-origin SVG fetch only (~20 lines)
├── test/              unit test page (test.html + tests.js) + ACCEPTANCE.md
└── README.md          install steps, limitations
```

No offscreen document. No build step, no framework, no dependencies. Plain JS.

### manifest.json

- `manifest_version: 3`
- `permissions`: `["clipboardRead", "clipboardWrite", "storage"]` (`storage` for the output-px setting)
- **No required host permissions.** Dragged-URL fetches run in the service worker under plain CORS: Wikimedia's upload host allows it, and wiki `File:` pages are resolved through the MediaWiki API (`origin=*`, CORS-open; the `Special:FilePath` redirect chain is *not* CORS-viable, since its 302 hop lacks the header). Other sites work when they permit cross-origin requests. `optional_host_permissions: ["<all_urls>"]` backs an off-by-default popup toggle ("fetch dragged SVGs from any site") for sites that don't; requests must originate from an extension page with a gesture, which is why the toggle lives in the popup and not the content script. This replaced the original blanket `host_permissions` grant for Web Store review (2026-07-22).
- `content_scripts`: match `https://docs.google.com/*`, inject `config.js`, `rasterize.js`, `content.js` at `document_idle`, **`all_frames: true` + `match_origin_as_fallback: true`**. Slides routes keyboard input through a hidden same-origin iframe (`docs-texteventtarget-iframe`); keydown fired inside an iframe never propagates to the top window's listeners, so triggers must be registered in every frame. The key-event iframe is `about:blank`, which URL match patterns alone never inject into; `match_origin_as_fallback` (Chrome 105+) is what actually gets the script in there. *(Confirmed by spike: without it, focus/keydown triggers are completely dead when the editor has focus.)* Chrome requires the match pattern's path to be `*` when using `match_origin_as_fallback`, so the Slides-only restriction is enforced in code instead: the content script bails immediately unless `window.top.location.pathname` starts with `/presentation/` (about:blank frames are same-origin, so `window.top` is readable).
- `background.service_worker`: `sw.js`, only role is the cross-origin SVG fetch

- `action.default_popup`: `popup.html`, the config panel: one number input for output px (longest side), 256–8192, saved to `chrome.storage.sync` on change; empty/invalid falls back to the 2048 default.

Storage holds exactly one key (`outputPx`). Network use is limited to fetching a URL the user just dragged.

### Triggers (content.js)

Convert-on-arrival, not intercept-on-paste. Intercepting the paste event races the conversion (paste fires before an async rewrite completes) and requires fighting Slides' hidden event-target iframe. Instead, rewrite the clipboard *before* the user pastes:

1. **`window` focus event**, the primary trigger. Fires on click-focus *and* Alt-Tab. Spike-confirmed: with the `clipboardRead` manifest permission, `navigator.clipboard.read()` succeeds from the content script with **no prompt and no user activation** (`activation=false` reads worked), so both focus paths are covered by this one trigger.
2. **Ctrl/Cmd keydown**, the backstop: capture phase, **registered in every frame** (see all_frames above; depending on where focus sits, keys land in the top frame or the hidden iframe; the spike observed both). Catches copies that happen while the Slides tab never loses focus (e.g. a clipboard manager). Fires on the modifier alone, so conversion has ~100ms+ head start before V lands.

**Frame coordination:** listeners run in every frame, but only the top frame reads, converts, and writes. Child frames forward triggers via `postMessage`. This keeps a single debounce and a single loop guard, so two frames can't race to convert the same clipboard. (Spike confirmed: the top frame reads *and writes* the clipboard fine while focus sits inside the key-event iframe.)

Debounce: skip if a check ran in the last 500ms.

### Drag-and-drop interception (content.js)

Listen for `drop` in the capture phase on `window`, before Slides sees it, in every frame for safety, though the spike showed canvas drops arrive in the **top frame** (the slide canvas is inline SVG in the top document) and Slides cancels them in the bubble phase, so a capture listener always sees the event first. Unlike paste, drop data is synchronously readable inside the event and the native handling can simply be cancelled, so there is no race and no clipboard permission involved on the read side.

On drop, inspect `dataTransfer` in this order and take the first match:

1. **File**: an entry in `dataTransfer.files` with type `image/svg+xml` or a `.svg` extension → read as text. (Covers dragging a file from Finder/Explorer, and closes the gap the clipboard API leaves for copied files.)
2. **Markup**: `text/plain` passing the same strict `<svg` prefix rule as paste → use directly. (Covers dragging selected SVG code.)
3. **URL**: `text/uri-list` ending in `.svg` or `text/html` whose only content is an `<img>` with an `.svg` src → message `sw.js` to fetch it, expect SVG back (validated with the same strict prefix rule, so an HTML page from a URL that merely *ends* in `.svg` is rejected). (Covers dragging an SVG image from another web page, where the drag payload is a URL, not pixels.) `sw.js` resolves Wikipedia/Wikimedia `…/wiki/File:X.svg` description-page URLs to the actual file via the MediaWiki API (`prop=imageinfo`, `origin=*`), so dragging from Commons pages and Wikipedia article thumbnails works without any host permission (added 2026-07-22 after acceptance testing; switched from `Special:FilePath` to the API when host permissions were dropped for the store build).

If any rule matches: `preventDefault()` + `stopImmediatePropagation()` (the native drop would fail anyway), convert through the same `rasterizeSvg` pipeline, write PNG + original markup to the clipboard, then auto-place: the top frame posts the PNG blob to the key-event iframe's content script, which dispatches a synthetic `ClipboardEvent('paste')` (DataTransfer + File) on its focused element. Slides handles it despite `isTrusted: false`; `defaultPrevented` on the dispatched event is the success signal (400ms timeout → fallback). Success toast "SVG placed"; fallback toast "SVG converted. Press Ctrl/Cmd+V to place it".

If nothing matches: do not touch the event. Ordinary image and text drops must behave exactly as stock Slides.

**View-only decks:** stock Slides rejects all drops there, so an uncancelled drop makes the browser *navigate to the dragged file*. That is default browser behavior, not a bug (discovered during the spike). Our interception still runs on view-only decks; that's fine and arguably an improvement (cancelling the drop prevents the nav-away), but the paste that follows won't place anything. Acceptable for MVP; the toast text stays the same.

**Why clipboard delivery instead of dropping the PNG in place:** completing the drop ourselves means dispatching a synthetic `DragEvent` carrying the PNG as a `File`. Synthetic events are `isTrusted: false` and Slides may ignore them; that's a test-and-see enhancement, not an MVP dependency. Clipboard + paste is deterministic and reuses the pipeline that already exists. See Future.

**Do not intercept `dragover`:** drag data contents are not readable until drop (only type names are visible), so no pre-conversion is possible mid-drag. Let the browser show its normal drag UI.

### Detection

Read via `navigator.clipboard.read()`. An SVG is present when either:

- an item exposes type `image/svg+xml` (Chrome's async clipboard supports this natively, with built-in sanitization), or
- `text/plain` content, after stripping leading whitespace, XML prolog (`<?xml…?>`), doctype, and comments, begins with `<svg`.

Strict prefix match. Do not scan mid-string for `<svg`: copied HTML or prose that merely contains an SVG must not trigger.

**Loop guard:** keep an in-memory hash of the last-converted SVG source. If the clipboard's SVG matches it, skip (we already converted; the text/plain copy we preserved would otherwise retrigger forever).

### Conversion (rasterize.js)

Pure async function: `rasterizeSvg(svgText, outputPx) → Promise<{blob, width, height}>`. `outputPx` comes from `getOutputPx()` (the stored setting, default 2048).

- Parse with `DOMParser`. Reject on `parsererror`.
- **External-resource pre-scan:** after parsing, scan the SVG DOM for external references: `<image>`/`<use>` with a non-`data:`, non-fragment `href`/`xlink:href`, and `url(http…)` in style attributes. Reject with a distinct error if found. This must be a *pre*-scan: SVG loaded via `<img>` renders in SVG-as-image mode, where external resources are silently omitted (the canvas never taints and `toBlob` succeeds), so there is no downstream error to catch. Without the scan the user would get a PNG with blank areas and no explanation.
- Resolve intrinsic size: `width`/`height` attrs, else `viewBox`, else default 512×512. If no `viewBox`, synthesize one from width/height so scaling works.
- Scale so the longest side = `OUTPUT_PX` (2048), aspect preserved.
- Set explicit pixel `width`/`height` on the root element, serialize, load into an `Image` via blob URL, draw onto a canvas of the output size, `canvas.toBlob('image/png')`.
- Transparent background. Never fill.

**CSP risk, resolved by spike:** blob-URL `Image` load → canvas → `toBlob('image/png')` works in the docs.google.com page context. No `chrome-extension://` iframe fallback needed; don't build one.

### Clipboard rewrite

Write both formats in one `clipboard.write()`:

- `image/png`: the rendered PNG (what Slides consumes)
- `text/plain`: the *original* SVG markup, unmodified

Preserving the text means a later paste into a code editor still yields the SVG source. The loop guard above prevents this from causing reconversion.

### Toast

- Injected `<div>`, fixed position bottom-center, ~13px, dark pill, no framework.
- Success: "SVG ready. Paste as PNG" (clipboard flow) / "SVG placed" (drop flow), auto-dismiss 2.5s.
- Failure: "SVG couldn't be converted" + one-line reason (auto-dismiss 4s). On failure the clipboard is left untouched.
- Never more than one toast at a time.

## Failure handling

| Case | Behavior |
|---|---|
| Clipboard has no SVG | Silent no-op |
| Malformed SVG (parse error) | Error toast, clipboard untouched |
| SVG references external resources (caught by pre-scan) | Error toast: "SVG uses external images" |
| Clipboard read rejected (no gesture/focus) | Silent no-op, retry on next trigger |
| Clipboard write rejected | Error toast |
| Dragged URL fetch fails (network, 404, not SVG) | Error toast: "Couldn't fetch that SVG" + reason; a CORS block suggests enabling the "any site" popup toggle |
| Non-SVG drop (PNG, text, etc.) | Untouched, native Slides behavior |

Never throw uncaught. Never block or modify Slides' own behavior in any other way.

## Privacy

Everything runs locally. No network requests (beyond fetching a URL the user just dragged), no storage, no analytics, no data leaves the machine. State one sentence to this effect in the README. Note: the focus/keydown triggers mean the extension reads the clipboard whenever a Slides tab is focused. Contents never leave the page, but the README should say so plainly.

## Spike results (2026-07-22)

Run on Chrome stable with a throwaway probe extension (since deleted). All four original open questions answered:

1. **Clipboard read permission:** `navigator.clipboard.read()` succeeds from the content script with the `clipboardRead` manifest permission, and **no user activation is required** (reads with `activation=false` succeeded on focus, Alt-Tab, and keydown). Chrome showed **one clipboard permission prompt around install/first use**; after that one-time grant, every read was silent. The README must say so: "Chrome will ask for clipboard access once. Click Allow." Writes with `image/png` + `text/plain` also succeed and were verified by immediate readback.
2. **Cross-frame:** top frame reads and writes fine while focus sits inside `docs-texteventtarget-iframe`; the postMessage relay-to-top design works. Keydown lands in the top frame *or* the key-event iframe depending on focus state; both were observed, so per-frame listeners + relay are genuinely needed.
3. **CSP raster path:** blob URL → `Image` → canvas → `toBlob` works in the page context. No fallback needed.
4. **Drop target:** canvas drops fire in the **top frame** (canvas is inline SVG in the top document; drop targets were `rect`/`image`/`path` elements). Slides cancels drops in the bubble phase, so capture-phase listeners run first, as designed.

Incidental findings, already folded in above: the key-event iframe is `about:blank` (needs `match_origin_as_fallback`, which forces the match pattern to `docs.google.com/*` with an in-code Slides-only guard), and view-only decks reject all drops, making the browser navigate to the dragged file (stock behavior, not extension interference).

## Acceptance tests (manual)

1. Copy SVG markup from a text editor → focus Slides tab → toast appears → Ctrl+V → PNG lands on slide, transparent background, sharp at full-slide size.
2. Same, but tab already focused (Alt-Tab back, no click) → Ctrl+V works via the keydown backstop.
3. Copy from Figma with "Copy as SVG" → paste works.
4. SVG with `viewBox` but no width/height → correct aspect, 2048px longest side.
5. Wide SVG (e.g. 4:1) → 2048×512 output, not distorted.
6. Copy plain text / an ordinary image / rich HTML → no toast, paste behaves exactly as stock Slides.
7. After conversion, paste into VS Code → original SVG markup appears.
8. Paste twice in a row in Slides → both paste PNG, only one conversion (loop guard works).
9. Malformed SVG (`<svg` unclosed) → error toast, clipboard unchanged.
10. Extension inert on docs.google.com/document (Docs) → script injects (pattern is docs.google.com/*) but bails at the top-URL guard: no listeners, no toast, no console errors.
11. Drag a `.svg` file from the file manager onto a slide → "SVG placed" toast, image lands with no keypress.
12. Drag an SVG onto a slide from each of: a raw `.svg` URL opened in a tab, a Wikimedia Commons `File:` page, and a Wikipedia article thumbnail (link target is the `File:` page, rewritten via `Special:FilePath`) → fetched, converted, auto-placed.
13. Drag a PNG or JPEG onto a slide → extension does nothing, native drop works as stock.
14. Set output px to 1024 in the popup → paste is 1024 longest side; clear the field → paste is 2048 again.
15. With "any site" off, drag an SVG image from a non-CORS site → error toast names the block and points at the popup toggle; enable the toggle (Chrome prompts once) → the same drag converts.

## Definition of done

All 15 acceptance tests pass on current Chrome stable, loaded unpacked.

## Store packaging

`store/LISTING.md` holds the complete dashboard kit: descriptions, single-purpose statement, per-permission justifications, and data-usage answers. `store/build.sh` zips exactly the runtime files + icons. Privacy policy is served at <https://vizkid.github.io/savage/privacy.html> (GitHub Pages, `docs/`). Icons are the amber star at 16/32/48/128. Owner steps: $5 developer registration, upload zip, paste listing, submit. Total code under ~500 lines. No console errors on docs.google.com with the extension idle.

## Future (explicitly not now)

- ~~**Native vector paste**~~ *(Shipped 2026-07-23 for the drop/URL flow — spec: `VECTOR-SPEC.md`, format research: `research/FINDINGS.md`. Remaining follow-ups live in VECTOR-SPEC's Future section: the Cmd+V clipboard flow via paste interception, and text-to-curves.)*
- Drop-at-cursor coordinates: auto-place lands at Slides' default paste position. Dispatching a synthetic `drop` DragEvent at the original coordinates might place exactly at the drop point. Untested, and low value now that auto-place works.
- Docs/Sheets support.
