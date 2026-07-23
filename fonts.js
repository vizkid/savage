'use strict';

// Font logic for text-to-curves: @font-face extraction from SVG <style>
// blocks, the face-resolution ladder (embedded → fetched → bundled Roboto),
// and the Google-Fonts css parser. Pure: no extension APIs — the network step
// is an injected fetcher, so the extension and the test page wire it
// differently. Depends on the vendored `opentype` global; the bundled face
// additionally needs ROBOTO_REGULAR_TTF_BASE64 (vendor/roboto-regular.js).
// Loaded by the content-script chain, the unit-test page, and (for
// parseGoogleFontsCss only) the service worker via importScripts.

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// A <style> block is acceptable iff it contains only @font-face rules with
// base64 data-URI sources. Returns Map<family(lowercase), ArrayBuffer>, or
// null when any other CSS (or a non-data source) is present.
function fontFaceOnlyStyle(cssText) {
  const stripped = (cssText || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const faces = stripped.match(/@font-face\s*\{[^}]*\}/g) || [];
  let rest = stripped;
  for (const face of faces) rest = rest.replace(face, '');
  if (rest.trim() !== '') return null;
  const map = new Map();
  for (const face of faces) {
    const fam = /font-family\s*:\s*['"]?([^'";}]+)/.exec(face);
    const src = /src\s*:[^;}]*url\(\s*['"]?(data:[^'")]+)['"]?\s*\)/.exec(face);
    if (!fam || !src) return null;
    const data = /^data:[^,]*;base64,(.*)$/.exec(src[1]);
    if (!data) return null;
    try {
      map.set(fam[1].trim().toLowerCase(), b64ToArrayBuffer(data[1]));
    } catch (_) {
      return null;
    }
  }
  return map;
}

let __bundledFont = null;
function getBundledFont() {
  if (!__bundledFont) {
    __bundledFont = opentype.parse(b64ToArrayBuffer(ROBOTO_REGULAR_TTF_BASE64));
  }
  return __bundledFont;
}

// css2 response (fetched with a legacy user-agent) → first TTF url.
function parseGoogleFontsCss(cssText) {
  const m = /url\(\s*['"]?(https:\/\/fonts\.gstatic\.com\/[^'")]+\.ttf)['"]?\s*\)/.exec(cssText || '');
  return m ? m[1] : null;
}

// First family in a font-family list, quotes stripped, original casing
// (Google Fonts wants canonical names; embedded lookup lowercases itself).
function firstFamily(familyList) {
  return (familyList || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
}

// CSS font-weight → the nearest registered static weight for css2 requests.
function cssWeight(w) {
  const named = { normal: 400, bold: 700 };
  const key = String(w == null ? '' : w).trim().toLowerCase();
  const n = named[key] !== undefined ? named[key] : parseInt(key, 10);
  if (!Number.isFinite(n)) return 400;
  return Math.min(900, Math.max(100, Math.round(n / 100) * 100));
}

// --- glyph outlines → evenodd-safe rings ---
// Fonts are authored for the NONZERO fill rule and exploit it freely:
// overlapping same-winding contours (Roboto 'H' = stems + crossbar) and
// self-intersecting "keyhole" counters (Roboto 'e' tunnels through a
// zero-width slit). Slides fills freeforms EVENODD, so raw glyph outlines
// render with notches and hairline cracks. Fix: flatten curves to polylines
// and normalize through Clipper's SimplifyPolygons with nonzero fill —
// the reference primitive for exactly this — yielding rings that render
// identically under any fill rule. Sub-pixel flattening is invisible at
// slide scale and op-1 polylines always sync (research/FINDINGS.md).

function vecFlattenSteps(chord) {
  return Math.max(2, Math.min(64, Math.ceil(chord / 1.5)));
}

// opentype path commands → array of contours ([[x,y], ...], open form).
function flattenGlyphCommands(commands) {
  const contours = [];
  let cur = null;
  let px = 0;
  let py = 0;
  for (const c of commands) {
    if (c.type === 'M') {
      cur = [[c.x, c.y]];
      contours.push(cur);
      px = c.x;
      py = c.y;
    } else if (c.type === 'L' && cur) {
      cur.push([c.x, c.y]);
      px = c.x;
      py = c.y;
    } else if ((c.type === 'Q' || c.type === 'C') && cur) {
      const x0 = px;
      const y0 = py;
      let at;
      let chord;
      if (c.type === 'Q') {
        chord = Math.hypot(c.x1 - x0, c.y1 - y0) + Math.hypot(c.x - c.x1, c.y - c.y1);
        at = (t) => {
          const a = 1 - t;
          return [
            a * a * x0 + 2 * a * t * c.x1 + t * t * c.x,
            a * a * y0 + 2 * a * t * c.y1 + t * t * c.y,
          ];
        };
      } else {
        chord = Math.hypot(c.x1 - x0, c.y1 - y0) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) +
          Math.hypot(c.x - c.x2, c.y - c.y2);
        at = (t) => {
          const a = 1 - t;
          return [
            a * a * a * x0 + 3 * a * a * t * c.x1 + 3 * a * t * t * c.x2 + t * t * t * c.x,
            a * a * a * y0 + 3 * a * a * t * c.y1 + 3 * a * t * t * c.y2 + t * t * t * c.y,
          ];
        };
      }
      const n = vecFlattenSteps(chord);
      for (let i = 1; i <= n; i++) cur.push(at(i / n));
      px = c.x;
      py = c.y;
    }
  }
  const out = [];
  for (const cont of contours) {
    const clean = [];
    for (const pt of cont) {
      const prev = clean[clean.length - 1];
      if (!prev || Math.abs(prev[0] - pt[0]) > 1e-6 || Math.abs(prev[1] - pt[1]) > 1e-6) clean.push(pt);
    }
    const f = clean[0];
    const l = clean[clean.length - 1];
    if (clean.length > 1 && Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) clean.pop();
    if (clean.length >= 3) out.push(clean);
  }
  return out;
}

// Clipper works on integers: px × 1000 keeps ~0.4 page-unit precision.
const FONT_CLIP_SCALE = 1000;

// opentype path commands → M/L/Z segments, normalized from the font's
// nonzero fill semantics to evenodd-safe rings via Clipper.
function glyphCommandsToSegments(commands) {
  const contours = flattenGlyphCommands(commands);
  if (!contours.length) return [];
  const paths = contours.map((c) => c.map(([x, y]) => ({
    X: Math.round(x * FONT_CLIP_SCALE),
    Y: Math.round(y * FONT_CLIP_SCALE),
  })));
  const clean = ClipperLib.Clipper.SimplifyPolygons(paths, ClipperLib.PolyFillType.pftNonZero);
  const segments = [];
  for (const ring of clean) {
    if (ring.length < 3) continue;
    segments.push(['M', ring[0].X / FONT_CLIP_SCALE, ring[0].Y / FONT_CLIP_SCALE]);
    for (let i = 1; i < ring.length; i++) {
      segments.push(['L', ring[i].X / FONT_CLIP_SCALE, ring[i].Y / FONT_CLIP_SCALE]);
    }
    segments.push(['Z']);
  }
  return segments;
}

// Resolution ladder: embedded @font-face → injected fetcher (Google Fonts
// via the service worker) → bundled Roboto. A present-but-unparseable
// embedded font returns null (PNG fallback) — never silently the wrong face.
async function defaultResolveFont({ family, weight }, embeddedFaces, fetcher) {
  const fam = firstFamily(family);
  if (fam && embeddedFaces && embeddedFaces.has(fam.toLowerCase())) {
    try {
      return opentype.parse(embeddedFaces.get(fam.toLowerCase()));
    } catch (_) {
      return null;
    }
  }
  if (fam && fetcher) {
    try {
      const buf = await fetcher({ family: fam, weight });
      if (buf) return opentype.parse(buf);
    } catch (_) {}
  }
  try {
    return getBundledFont();
  } catch (_) {
    return null;
  }
}
