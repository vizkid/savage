'use strict';

// Vector-paste spike. Flow: copy the CONTENTS of a savage-clip-dump-*.json
// file (plain text) to the clipboard, focus Slides, press Ctrl/Cmd+Shift+9.
// The probe parses the dump, rebuilds a DataTransfer with every flavor in it
// (including Google's slice-clip type), and dispatches a synthetic paste on
// the focused element. If Slides accepts custom-type synthetic pastes, the
// original vector shape reappears natively.

let inSlides = false;
try {
  inSlides = window.top.location.pathname.startsWith('/presentation/');
} catch (_) {}
if (inSlides) main();

function main() {
  const isTop = window === window.top;
  const frameDesc = isTop
    ? 'TOP'
    : `IFRAME(${(window.frameElement && window.frameElement.className) || 'anon'})`;

  function report(...args) {
    console.log('[vector-spike]', frameDesc, ...args);
  }

  async function replay() {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      report('clipboard readText failed:', err.message);
      return;
    }
    let dump;
    try {
      dump = JSON.parse(text);
    } catch (_) {
      report('clipboard text is not a JSON dump (copy the dump file contents first)');
      return;
    }
    const dt = new DataTransfer();
    const set = [];
    for (const [type, value] of Object.entries(dump)) {
      if (typeof value !== 'string' || type === 'Files') continue;
      try {
        dt.setData(type, value);
        set.push(type);
      } catch (err) {
        report(`setData(${type}) failed:`, err.message);
      }
    }
    report('replaying flavors:', set.join(', '));
    const ev = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    const target = document.activeElement || document.body || document.documentElement;
    const notCancelled = target.dispatchEvent(ev);
    report(
      `synthetic paste dispatched on <${target.tagName}> defaultPrevented=${ev.defaultPrevented} cancelled=${!notCancelled}`
    );
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === '9' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        report('hotkey in this frame; replaying here');
        replay();
      }
    },
    true
  );

  report('injected');
}
