'use strict';

// The match pattern is docs.google.com/* (match_origin_as_fallback forces the
// path to '*'), so the Slides-only restriction lives here. about:blank frames
// are same-origin, so window.top is readable.
(() => {
  let inSlides = false;
  try {
    inSlides = window.top.location.pathname.startsWith('/presentation/');
  } catch (_) {}
  if (!inSlides) return;

  const ORIGIN = 'https://docs.google.com';
  const MSG = 'svg-paste-slides';
  const isTop = window === window.top;
  const PASTE_KEY = /Mac/.test(navigator.platform) ? 'Cmd+V' : 'Ctrl+V';

  function debug(...args) {
    console.log('[svg-paste]', isTop ? 'top' : 'iframe', ...args);
  }

  // ---------- toast (top frame only; children relay everything to top) ----------

  let toastEl = null;
  let toastTimer = 0;

  function toast(text, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
        'z-index:2147483647;padding:8px 16px;border-radius:999px;color:#fff;' +
        'font:13px/1.4 system-ui,sans-serif;pointer-events:none;' +
        'transition:opacity .3s;opacity:0;max-width:70vw;';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.background = isError ? 'rgba(160,40,40,.95)' : 'rgba(32,33,36,.95)';
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = '0';
    }, isError ? 4000 : 2500);
  }

  // ---------- conversion (top frame only) ----------

  let lastCheck = 0;
  let lastProcessed = ''; // loop guard: the preserved text/plain would retrigger forever

  // Converts and rewrites the clipboard. Toasts on failure; toasts successMsg
  // only if given. Returns {blob} on success, null on failure.
  async function convertAndWrite(svgText, successMsg) {
    lastProcessed = svgText;
    let blob;
    try {
      ({ blob } = await rasterizeSvg(svgText, await getOutputPx()));
    } catch (err) {
      toast(`SVG couldn't be converted: ${err.message}`, true);
      return null; // clipboard untouched
    }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob,
          'text/plain': new Blob([svgText], { type: 'text/plain' }),
        }),
      ]);
    } catch (_) {
      toast("SVG couldn't be converted: clipboard write was blocked", true);
      return null;
    }
    if (successMsg) toast(successMsg);
    return { blob };
  }

  // Auto-place: dispatch a synthetic paste (isTrusted=false, proven accepted)
  // into Slides' key-event iframe. payload: {blob} posts a PNG file; {vector}
  // posts the custom-flavor map from svgToSliceClip (the async clipboard API
  // cannot carry custom types, so this channel is the only vector delivery).
  function autoPaste(payload) {
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    if (!iframe || !iframe.contentWindow) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, 400);
      function onMsg(e) {
        if (e.origin !== ORIGIN || !e.data) return;
        const m = e.data[MSG];
        if (!m || m.kind !== 'paste-result') return;
        cleanup();
        resolve(!!m.handled);
      }
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
      }
      window.addEventListener('message', onMsg);
      iframe.contentWindow.postMessage({ [MSG]: { kind: 'paste', ...payload } }, ORIGIN);
    });
  }

  // Google-Fonts rung of the text-to-curves ladder (fonts.js), served by the
  // service worker. Failing (no host access, offline, unknown family) just
  // drops resolution to the bundled face.
  async function fetchFontViaSw(spec) {
    // chrome.runtime is gone in orphaned content scripts (extension reloaded
    // without a tab reload) and in opaque-origin frames — degrade to bundled.
    if (!(chrome && chrome.runtime && chrome.runtime.sendMessage)) {
      debug('fetch-font unavailable: no chrome.runtime (reload the Slides tab)');
      return null;
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'fetch-font',
        family: spec.family,
        weight: spec.weight,
      });
      if (resp && resp.ok && resp.b64) return b64ToArrayBuffer(resp.b64);
      if (resp && resp.error) debug('fetch-font:', resp.error);
    } catch (err) {
      debug('fetch-font failed:', err);
    }
    return null;
  }

  function convertToVector(svgText) {
    // The converter libs load in a separate content-script entry scoped to the
    // Slides top frame (manifest). If they somehow aren't present yet, degrade
    // to the PNG path rather than throw.
    if (typeof svgToSliceClip !== 'function') return Promise.resolve(null);
    return svgToSliceClip(svgText, { fetchFont: fetchFontViaSw });
  }

  // ---------- last-conversion stash (top frame owns it) ----------

  let lastStash = null; // {svgText, vector|null, blob|null}

  function stashConversion(svgText, vector, blob) {
    lastStash = { svgText, vector, blob };
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ [MSG]: { kind: 'stash', svgText, vector } }, ORIGIN);
    }
  }

  // Best-effort clipboard PNG + markup after a vector paste: keeps manual
  // Cmd+V reuse and the Cmd+Shift+V hatch working, without toasting failures.
  async function writeClipboardQuiet(svgText) {
    try {
      const { blob } = await rasterizeSvg(svgText, await getOutputPx());
      lastProcessed = svgText;
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob,
          'text/plain': new Blob([svgText], { type: 'text/plain' }),
        }),
      ]);
      if (lastStash && lastStash.svgText === svgText) lastStash.blob = blob;
    } catch (err) {
      debug('quiet clipboard write failed:', err);
    }
  }

  // Cmd+Shift+V (the iframe swallowed it because a conversion exists).
  // Clipboard still matches the stash → deliver the PNG; anything else →
  // plain-text paste of the actual clipboard, i.e. native
  // paste-without-formatting behavior.
  async function handleForcePng() {
    if (!lastStash) return;
    let clipText = null;
    try {
      clipText = await navigator.clipboard.readText();
    } catch (_) {}
    if (clipText === lastStash.svgText) {
      let blob = lastStash.blob;
      if (!blob) {
        try {
          ({ blob } = await rasterizeSvg(lastStash.svgText, await getOutputPx()));
          lastStash.blob = blob;
        } catch (err) {
          toast(`SVG couldn't be converted: ${err.message}`, true);
          return;
        }
      }
      const placed = await autoPaste({ blob });
      toast(placed ? 'Pasted as PNG' : `PNG is on the clipboard. Press ${PASTE_KEY}`);
    } else {
      await autoPaste({ text: clipText || '' });
    }
  }

  async function checkClipboard() {
    const now = Date.now();
    if (now - lastCheck < 500) return;
    lastCheck = now;

    let svgText = null;
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes('image/svg+xml')) {
          svgText = await (await item.getType('image/svg+xml')).text();
          break;
        }
      }
      if (!svgText) {
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            const text = await (await item.getType('text/plain')).text();
            svgText = extractSvgFromText(text);
            break;
          }
        }
      }
    } catch (_) {
      return; // read rejected or unreadable: silent no-op, retry on next trigger
    }
    if (!svgText || svgText === lastProcessed) return;
    const vector = await convertToVector(svgText);
    const result = await convertAndWrite(svgText, null);
    if (!result) return;
    stashConversion(svgText, vector, result.blob);
    toast(vector ? 'SVG ready. Paste to place it as shapes' : 'SVG ready. Paste as PNG');
  }

  async function handleSvgPayload({ svgText, url }) {
    if (url) {
      let resp = null;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'fetch-svg', url });
      } catch (err) {
        debug('fetch-svg sendMessage failed:', err);
      }
      debug('fetch-svg response:', resp && { ok: resp.ok, error: resp.error, len: resp.text && resp.text.length });
      if (!resp || !resp.ok || !extractSvgFromText(resp.text)) {
        const reason = !resp
          ? 'no response from service worker'
          : resp.error || 'response was not SVG';
        toast(`Couldn't fetch that SVG: ${reason}`, true);
        return;
      }
      svgText = resp.text;
    }
    // Native vectors first: convert to editable Slides shapes when the SVG is
    // in scope; anything else falls through to the proven PNG pipeline.
    const vector = await convertToVector(svgText);
    if (vector) {
      const placedVector = await autoPaste({ vector });
      debug('vector autoPaste handled:', placedVector);
      if (placedVector) {
        toast('SVG pasted as editable shapes');
        stashConversion(svgText, vector, null);
        writeClipboardQuiet(svgText); // clipboard symmetry, off the hot path
        return;
      }
    }
    // PNG fallback. Auto-place is a synthetic paste and needs no clipboard, so
    // it must not be gated on the clipboard write (which can be blocked when
    // the drop's transient activation has lapsed) — rasterize, place, then
    // write the clipboard best-effort for manual re-paste.
    let blob;
    try {
      ({ blob } = await rasterizeSvg(svgText, await getOutputPx()));
    } catch (err) {
      toast(`SVG couldn't be converted: ${err.message}`, true);
      return;
    }
    stashConversion(svgText, vector, blob);
    const placed = await autoPaste({ blob });
    debug('autoPaste handled:', placed);
    writeClipboardQuiet(svgText);
    toast(placed ? 'SVG placed' : `SVG converted. Press ${PASTE_KEY} to place it`);
  }

  // ---------- frame relay: children forward, only the top frame acts ----------

  function relay(payload) {
    try {
      window.top.postMessage({ [MSG]: payload }, ORIGIN);
    } catch (_) {}
  }

  function requestCheck() {
    if (isTop) checkClipboard();
    else relay({ kind: 'check' });
  }

  if (isTop) {
    window.addEventListener('message', (e) => {
      if (e.origin !== ORIGIN || !e.data) return;
      const m = e.data[MSG];
      if (!m) return;
      if (m.kind === 'check') checkClipboard();
      else if (m.kind === 'svg') handleSvgPayload(m);
      else if (m.kind === 'intercepted') toast('SVG pasted as editable shapes');
      else if (m.kind === 'force-png') handleForcePng();
    });
  }
  // The key-event-iframe side (synthetic paste dispatch, Cmd+V vector swap,
  // Cmd+Shift+V hatch) lives in iframe-paste.js.

  // ---------- triggers: convert-on-arrival, before the user pastes ----------

  window.addEventListener('focus', requestCheck);
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Meta' || e.key === 'Control') requestCheck();
    },
    true
  );

  // ---------- drag-and-drop interception ----------

  function firstSvgFile(dt) {
    for (const f of dt.files) {
      if (f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)) return f;
    }
    return null;
  }

  function svgUrlFrom(dt) {
    const uri = (dt.getData('text/uri-list') || '')
      .split(/\r?\n/)
      .find((l) => l && !l.startsWith('#'));
    if (uri && /^https?:/i.test(uri) && /\.svg([?#]|$)/i.test(uri)) return uri;
    const html = dt.getData('text/html');
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const imgs = doc.querySelectorAll('img');
      const src = imgs.length === 1 ? imgs[0].getAttribute('src') || '' : '';
      if (
        /^https?:/i.test(src) &&
        /\.svg([?#]|$)/i.test(src) &&
        !(doc.body.textContent || '').trim()
      ) {
        return src;
      }
    }
    return null;
  }

  function deliver(payload) {
    if (isTop) handleSvgPayload(payload);
    else relay({ kind: 'svg', ...payload });
  }

  // First match wins: file → markup → URL. Anything else stays native.
  window.addEventListener(
    'drop',
    (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      debug('drop:', {
        types: Array.from(dt.types),
        files: Array.from(dt.files).map((f) => `${f.name}|${f.type}`),
        uriList: dt.getData('text/uri-list'),
        textPrefix: (dt.getData('text/plain') || '').slice(0, 60),
      });
      const file = firstSvgFile(dt);
      const markup = file ? null : extractSvgFromText(dt.getData('text/plain'));
      const url = file || markup ? null : svgUrlFrom(dt);
      debug('drop rule:', file ? `file ${file.name}` : markup ? 'markup' : url ? `url ${url}` : 'no match, native');
      if (!file && !markup && !url) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (file) {
        file
          .text()
          .then((t) => deliver({ svgText: t }))
          .catch(() => deliver({ svgText: '' }));
      } else if (markup) {
        deliver({ svgText: markup });
      } else {
        deliver({ url });
      }
    },
    true
  );
})();
