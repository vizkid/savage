'use strict';

// Key-event-iframe side of Savage (content.js keeps the top-frame logic).
// Dispatches synthetic pastes requested by the top frame, caches the last
// conversion stash, swaps trusted Cmd+V pastes for the vector payload while
// the clipboard still holds that converted SVG, and turns Cmd+Shift+V into
// paste-as-PNG — paste-without-formatting is meaningless for an SVG paste,
// and unrelated clipboards fall through to a plain-text paste so the native
// contract holds.
(() => {
  let inSlides = false;
  try {
    inSlides = window.top.location.pathname.startsWith('/presentation/');
  } catch (_) {}
  if (!inSlides || window === window.top) return;

  const ORIGIN = 'https://docs.google.com';
  const MSG = 'svg-paste-slides';
  let stash = null; // {svgText, vector|null} — latest conversion, posted by top

  function debug(...args) {
    console.log('[svg-paste]', 'iframe', ...args);
  }

  function relay(payload) {
    try {
      window.top.postMessage({ [MSG]: payload }, ORIGIN);
    } catch (_) {}
  }

  function dispatchPaste(fill) {
    const dt = new DataTransfer();
    fill(dt);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    const target = document.activeElement || document.body || document.documentElement;
    const notCancelled = target.dispatchEvent(ev);
    return ev.defaultPrevented || !notCancelled;
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || !e.data) return;
    const m = e.data[MSG];
    if (!m) return;
    if (m.kind === 'stash') {
      stash = m.svgText ? { svgText: m.svgText, vector: m.vector || null } : null;
      return;
    }
    if (m.kind !== 'paste') return;
    let handled = false;
    try {
      handled = dispatchPaste((dt) => {
        if (m.vector) {
          for (const [type, value] of Object.entries(m.vector)) dt.setData(type, value);
        } else if (typeof m.text === 'string') {
          dt.setData('text/plain', m.text);
        } else {
          dt.items.add(new File([m.blob], 'image.png', { type: 'image/png' }));
        }
      });
    } catch (err) {
      debug('synthetic paste failed:', err);
    }
    relay({ kind: 'paste-result', handled });
  });

  // Trusted Cmd+V whose clipboard still holds the converted SVG → swap in the
  // vector payload. Fully synchronous: clipboardData is readable inside the
  // event, so there is no race; synthetic pastes are isTrusted:false and skip.
  window.addEventListener(
    'paste',
    (e) => {
      if (!e.isTrusted || !stash || !stash.vector) return;
      let text = '';
      try {
        text = e.clipboardData.getData('text/plain');
      } catch (_) {
        return;
      }
      if (text !== stash.svgText) return;
      // Snapshot the native flavors first: if the vector dispatch is not
      // consumed we replay them so the user's paste is never lost.
      const flavors = [];
      const files = [];
      try {
        for (const type of e.clipboardData.types) {
          if (type === 'Files') continue;
          flavors.push([type, e.clipboardData.getData(type)]);
        }
        for (const f of e.clipboardData.files) files.push(f);
      } catch (_) {}
      e.preventDefault();
      e.stopImmediatePropagation();
      const vector = stash.vector;
      const handled = dispatchPaste((dt) => {
        for (const [type, value] of Object.entries(vector)) dt.setData(type, value);
      });
      debug('trusted paste intercepted, vector handled:', handled);
      if (handled) {
        relay({ kind: 'intercepted' });
      } else {
        const replayed = dispatchPaste((dt) => {
          for (const [type, value] of flavors) dt.setData(type, value);
          for (const f of files) dt.items.add(f);
        });
        debug('vector swap unconsumed, native replay handled:', replayed);
      }
    },
    true
  );

  // Cmd/Ctrl+Shift+V with a conversion on record: swallow synchronously and
  // let the top frame verify the clipboard, then serve PNG or plain text.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || !stash) return;
      if (e.key.toLowerCase() !== 'v' || !e.shiftKey || e.altKey || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      relay({ kind: 'force-png' });
    },
    true
  );

  debug('injected');
})();
