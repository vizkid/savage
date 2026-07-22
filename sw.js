'use strict';

// Sole role: fetch a dragged SVG URL (content scripts can't, cross-origin).
// Ships with NO host permissions: fetches rely on CORS. Wikimedia's upload
// host allows it, and wiki "File:" description pages are resolved to the
// real file through the MediaWiki API (origin=* enables CORS there). Other
// sites work if they allow cross-origin requests, or if the user grants the
// optional "<all_urls>" access from the popup.
importScripts('rasterize.js'); // for extractSvgFromText (pure string logic)

async function resolveWikiFileUrl(url) {
  const m = url.match(/^https:\/\/([^/]*wiki[mp]edia\.org)\/wiki\/[^/:]+:(.+\.svg)$/i);
  if (!m) return url;
  const title = 'File:' + decodeURIComponent(m[2]);
  const api =
    `https://${m[1]}/w/api.php?action=query&prop=imageinfo&iiprop=url` +
    `&format=json&origin=*&titles=${encodeURIComponent(title)}`;
  const data = await (await fetch(api)).json();
  const pages = (data.query && data.query.pages) || {};
  const first = Object.values(pages)[0];
  const real = first && first.imageinfo && first.imageinfo[0] && first.imageinfo[0].url;
  if (!real) throw new Error('file not found on the wiki');
  return real;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'fetch-svg') return;
  (async () => {
    try {
      const url = await resolveWikiFileUrl(msg.url);
      let res;
      try {
        res = await fetch(url, { credentials: 'omit' });
      } catch (_) {
        throw new Error('the site blocks cross-origin requests. Allow "any site" in the SaVaGe popup');
      }
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
