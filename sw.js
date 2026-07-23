'use strict';

// Sole role: fetch a dragged SVG URL (content scripts can't, cross-origin).
// Ships with NO host permissions: fetches rely on CORS. Wikimedia's upload
// host allows it, and wiki "File:" description pages are resolved to the
// real file through the MediaWiki API (origin=* enables CORS there). Other
// sites work if they allow cross-origin requests, or if the user grants the
// optional "<all_urls>" access from the popup.
// Also serves 'fetch-font': Google Fonts css2 → static TTF for
// text-to-curves. css2 only serves TTF urls to legacy user-agents, and fetch
// can't set the UA header, so a DNR session rule rewrites it on our own
// css2 requests (needs the optional "any site" host access to apply).
importScripts('rasterize.js'); // extractSvgFromText (pure string logic)
importScripts('fonts.js'); // parseGoogleFontsCss, cssWeight (pure string logic)

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

const FONT_UA_RULE_ID = 7331;
// css2 serves TTF only to UAs with no modern-browser token — a Firefox-40
// string still gets woff2 (which opentype can't read). This bare NT-5.1
// string reliably yields TTF (verified across Roboto + Lobster 2026-07-23).
const LEGACY_UA = 'Mozilla/5.0 (Windows NT 5.1)';

async function ensureFontUaRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [FONT_UA_RULE_ID],
    addRules: [{
      id: FONT_UA_RULE_ID,
      condition: {
        urlFilter: '||fonts.googleapis.com/css2',
        // A service-worker fetch is typed 'other', not 'xmlhttprequest';
        // list both so the rule actually fires on our request.
        resourceTypes: ['xmlhttprequest', 'other'],
      },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'user-agent', operation: 'set', value: LEGACY_UA }],
      },
    }],
  });
}

// css2 only serves TTF to legacy UAs; the DNR rule rewrites our UA, but
// updateSessionRules resolving doesn't guarantee the rule is live for the
// very next request. So try, and if the response is woff2 (no TTF url),
// re-ensure the rule and retry once — by then it's definitely enforced.
async function cssToTtfUrl(family, weight) {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  const url = `https://fonts.googleapis.com/css2?family=${fam}:wght@${weight}`;
  let sawWoff2 = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureFontUaRule().catch(() => {});
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`fonts API HTTP ${res.status}`);
    const css = await res.text();
    const ttf = parseGoogleFontsCss(css);
    if (ttf) return ttf;
    sawWoff2 = /\.woff2/.test(css);
    console.log('[svg-paste] css2 returned no TTF (woff2:', sawWoff2, ') attempt', attempt);
  }
  throw new Error(sawWoff2
    ? 'css2 served woff2 — UA rewrite rule did not apply to the SW fetch'
    : 'no TTF url (unknown family, or host access not granted)');
}

async function fetchGoogleFont(family, weight) {
  const ttfUrl = await cssToTtfUrl(family, weight);
  const fontRes = await fetch(ttfUrl, { credentials: 'omit' });
  if (!fontRes.ok) throw new Error(`font HTTP ${fontRes.status}`);
  const bytes = new Uint8Array(await fontRes.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin); // sendMessage can't carry ArrayBuffers
}

const fontCache = new Map();

// Warm the UA rule as soon as the worker spins up, so the common case never
// hits the retry above.
ensureFontUaRule().catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'fetch-font') return;
  (async () => {
    try {
      const weight = cssWeight(msg.weight);
      const key = `${msg.family}|${weight}`;
      if (!fontCache.has(key)) fontCache.set(key, await fetchGoogleFont(msg.family, weight));
      sendResponse({ ok: true, b64: fontCache.get(key) });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'fetch-svg') return;
  (async () => {
    try {
      const url = await resolveWikiFileUrl(msg.url);
      let res;
      try {
        res = await fetch(url, { credentials: 'omit' });
      } catch (_) {
        throw new Error('the site blocks cross-origin requests. Allow "any site" in the Savage popup');
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
