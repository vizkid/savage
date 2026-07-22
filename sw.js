'use strict';

// Sole role: fetch a dragged SVG URL cross-origin (content scripts can't).
importScripts('rasterize.js'); // for extractSvgFromText (pure string logic)

// Wikipedia/Commons "File:" description pages end in .svg but serve HTML.
// Special:FilePath redirects to the actual file, so rewrite those URLs —
// this also makes dragging SVG thumbnails out of Wikipedia articles work.
function normalizeSvgUrl(url) {
  const m = url.match(/^(https:\/\/[^/]*wiki[mp]edia\.org)\/wiki\/[^/:]+:(.+\.svg)$/i);
  return m ? `${m[1]}/wiki/Special:FilePath/${m[2]}` : url;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'fetch-svg') return;
  (async () => {
    try {
      const res = await fetch(normalizeSvgUrl(msg.url), { credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      const text = await res.text();
      if (!type.includes('image/svg') && !extractSvgFromText(text)) {
        throw new Error(`not an SVG (content-type: ${type.split(';')[0] || 'unknown'})`);
      }
      sendResponse({ ok: true, text });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true;
});
