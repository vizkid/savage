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

  // Experimental auto-place: dispatch a synthetic paste (isTrusted=false)
  // carrying the PNG into Slides' key-event iframe. Works only if Slides'
  // handler ignores isTrusted; the clipboard fallback always remains.
  function autoPaste(blob) {
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
      iframe.contentWindow.postMessage({ [MSG]: { kind: 'paste', blob } }, ORIGIN);
    });
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
    await convertAndWrite(svgText, 'SVG ready. Paste as PNG');
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
    const result = await convertAndWrite(svgText, null);
    if (!result) return;
    const placed = await autoPaste(result.blob);
    debug('autoPaste handled:', placed);
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
    });
  } else {
    // Key-event iframe side of the auto-paste experiment.
    window.addEventListener('message', (e) => {
      if (e.origin !== ORIGIN || !e.data) return;
      const m = e.data[MSG];
      if (!m || m.kind !== 'paste') return;
      let handled = false;
      try {
        const dt = new DataTransfer();
        dt.items.add(new File([m.blob], 'image.png', { type: 'image/png' }));
        const ev = new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        const target = document.activeElement || document.body || document.documentElement;
        const notCancelled = target.dispatchEvent(ev);
        handled = ev.defaultPrevented || !notCancelled;
      } catch (err) {
        debug('synthetic paste failed:', err);
      }
      relay({ kind: 'paste-result', handled });
    });
  }

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
