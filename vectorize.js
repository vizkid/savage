'use strict';

// svgToSliceClip(svgText) → clipboard-flavor map | null.
//
// Converts an SVG into Google Slides' native vector clipboard payload by
// MORPHING the shipped template capture (vector-template.js) — from-scratch
// payload assembly crashes the Slides editor (research/FINDINGS.md). Returns
// null on the first out-of-scope feature; the caller falls back to the PNG
// pipeline. Pure DOM/canvas logic: no extension APIs, no page state. Depends
// on pathdata.js (geometry) and rasterize.js (resolveSize).

const VEC_TYPE = 'application/x-vnd.google-docs-drawings-object+wrapped';
const VEC_SCALE = 381; // Slides page units per CSS px (36576/inch)
const VEC_PASTE_X = 36576; // pasted SVG's top-left lands at (1", 0.5")
const VEC_PASTE_Y = 18288;

// Elements that force PNG fallback wherever they appear (defs included).
// <text> converts via text-to-curves (fonts.js); <style> is allowed only
// when its content is exclusively @font-face rules (checked in the pre-scan).
const VEC_REJECT_ELEMENTS = new Set([
  'tspan', 'textPath', 'image', 'use', 'foreignObject', 'pattern',
  'mask', 'clipPath', 'filter', 'script', 'switch', 'symbol',
  'marker', 'animate', 'animateMotion', 'animateTransform', 'set',
]);
const VEC_SKIP_ELEMENTS = new Set([
  'defs', 'title', 'desc', 'metadata', 'linearGradient', 'radialGradient', 'stop', 'style',
]);
const VEC_PAINT_PROPS = [
  'fill', 'stroke', 'stroke-width', 'fill-rule', 'opacity', 'fill-opacity',
  'stroke-opacity', 'stroke-dasharray', 'mask', 'clip-path', 'filter',
  'font-family', 'font-size', 'font-weight', 'text-anchor', 'letter-spacing',
  'stop-color', 'stop-opacity',
];
const VEC_INHERITED = [
  'fill', 'stroke', 'stroke-width', 'fill-rule', 'fill-opacity', 'stroke-opacity',
  'font-family', 'font-size', 'font-weight', 'text-anchor', 'letter-spacing',
];

// Async: font resolution (text-to-curves) awaits network/parse work.
// opts.resolveFont overrides the whole face ladder (tests); opts.fetchFont
// injects just the network rung (the extension's service-worker fetch).
async function svgToSliceClip(svgText, opts) {
  try {
    return await vecConvert(svgText, opts || {});
  } catch (err) {
    console.debug('[svg-paste] vectorize fallback:', err.message);
    return null;
  }
}

// --- internals (vec prefix keeps the content-script global scope tidy) ---

function vecReject(why) {
  throw new Error(why);
}

let vecColorCtx = null;
// Any CSS color → {hex, alpha} via canvas normalization.
function vecColorAlpha(str) {
  if (!vecColorCtx) vecColorCtx = document.createElement('canvas').getContext('2d');
  vecColorCtx.fillStyle = '#000000';
  vecColorCtx.fillStyle = str;
  const v = vecColorCtx.fillStyle;
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    // Invalid keywords leave the reset value; catch obvious ones.
    if (v === '#000000' && str.trim() !== '' && !/^(#0*|black|rgb\(\s*0[\s,]+0[\s,]+0\s*\))/i.test(str.trim())) {
      vecReject(`unrecognized color ${str}`);
    }
    return { hex: v.toUpperCase(), alpha: 1 };
  }
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(v);
  if (m) {
    const hex = '#' + [m[1], m[2], m[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0').toUpperCase())
      .join('');
    return { hex, alpha: parseFloat(m[4]) };
  }
  vecReject(`unsupported color ${str}`);
}

// Strict variant for paints with no alpha channel in the format (strokes,
// gradient stops): any translucency rejects.
function vecColor(str) {
  const c = vecColorAlpha(str);
  if (c.alpha !== 1) vecReject(`translucent color ${str} unsupported here`);
  return c.hex;
}

// Props we recognize but that don't change our output — safe to accept and
// ignore in a <style> block: clip-rule (only affects clipping, which we
// reject), stroke cosmetics Slides can't represent (defaults apply), and dead
// Adobe/Fireworks export attrs. Keeps these common exports out of PNG fallback.
const VEC_STYLE_IGNORED = [
  'clip-rule', 'stroke-linejoin', 'stroke-linecap', 'stroke-miterlimit',
  'stroke-dashoffset', 'enable-background', 'overflow',
];
// Props Savage understands in a <style> block. Anything else (display,
// visibility, transform, mix-blend-mode, …) forces PNG fallback rather than
// silently mis-render, since we can't honor it.
const VEC_STYLE_PROP_SET = new Set([
  ...VEC_PAINT_PROPS, 'stop-color', 'stop-opacity', ...VEC_STYLE_IGNORED,
]);

function vecParseDecls(body, out) {
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).trim();
    if (v) out[k] = v;
  }
  return out;
}

// One simple selector: `tag`, `.class`, `tag.class`, or `*`. Anything with a
// combinator, id, pseudo, or attribute part returns null → PNG fallback.
function vecParseSelector(s) {
  const t = s.trim();
  if (t === '*') return { tag: '*' };
  const m = /^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?$/.exec(t);
  if (!m || (!m[1] && !m[2])) return null;
  return { tag: m[1] || undefined, cls: m[2] || undefined };
}

// Parse an SVG <style> into { faces: Map, rules: [{selectors, props}] }, or
// null on any construct we can't fully honor (media/keyframes/import, id or
// combinator selectors, unknown properties).
function vecParseStylesheet(cssText) {
  const stripped = (cssText || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const faces = new Map();
  let rest = stripped;
  for (const block of stripped.match(/@font-face\s*\{[^}]*\}/g) || []) {
    rest = rest.replace(block, '');
    const fam = /font-family\s*:\s*['"]?([^'";}]+)/.exec(block);
    const src = /src\s*:[^;}]*url\(\s*['"]?(data:[^'")]+)['"]?\s*\)/.exec(block);
    if (!fam || !src) return null;
    const data = /^data:[^,]*;base64,(.*)$/.exec(src[1]);
    if (!data) return null;
    try {
      faces.set(fam[1].trim().toLowerCase(), b64ToArrayBuffer(data[1]));
    } catch (_) {
      return null;
    }
  }
  if (/@[a-z-]/i.test(rest)) return null; // any other at-rule
  const rules = [];
  let m;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  while ((m = re.exec(rest)) !== null) {
    const selectors = [];
    for (const part of m[1].split(',')) {
      const sel = vecParseSelector(part);
      if (!sel) return null;
      selectors.push(sel);
    }
    const props = vecParseDecls(m[2], {});
    for (const k of Object.keys(props)) {
      if (!VEC_STYLE_PROP_SET.has(k)) return null;
    }
    if (Object.keys(props).length) rules.push({ selectors, props });
  }
  return { faces, rules };
}

// Highest specificity tier at which any of a rule's selectors matches el:
// 2 = class, 1 = type/universal, 0 = no match.
function vecMatchTier(el, selectors) {
  let tier = 0;
  const classes = (el.getAttribute('class') || '').split(/\s+/);
  for (const sel of selectors) {
    const tagOk = !sel.tag || sel.tag === '*' || sel.tag === el.localName;
    const clsOk = !sel.cls || classes.includes(sel.cls);
    if (tagOk && clsOk) tier = Math.max(tier, sel.cls ? 2 : 1);
  }
  return tier;
}

// Cascade (low→high): presentation attributes, CSS type rules, CSS class
// rules, inline style attribute.
function vecProps(el, rules) {
  const p = {};
  for (const name of VEC_PAINT_PROPS) {
    const v = el.getAttribute(name);
    if (v !== null) p[name] = v.trim();
  }
  for (const tier of [1, 2]) {
    for (const rule of rules || []) {
      if (vecMatchTier(el, rule.selectors) === tier) Object.assign(p, rule.props);
    }
  }
  const style = el.getAttribute('style');
  if (style) vecParseDecls(style, p);
  return p;
}

// Rejects out-of-scope features document-wide; returns { faces, rules } from
// the document's <style> blocks (parsed before the element checks so class
// styling is visible regardless of <style> position).
function vecPreScan(root) {
  const all = [root, ...root.querySelectorAll('*')];
  const faces = new Map();
  const rules = [];
  for (const el of all) {
    if (el.localName === 'style') {
      const sheet = vecParseStylesheet(el.textContent || '');
      if (!sheet) vecReject('<style> has unsupported rules');
      for (const [family, buf] of sheet.faces) faces.set(family, buf);
      rules.push(...sheet.rules);
    }
  }
  for (const el of all) {
    if (VEC_REJECT_ELEMENTS.has(el.localName)) vecReject(`<${el.localName}> is out of scope`);
    if (el !== root && el.localName === 'svg') vecReject('nested <svg>');
    if (el.localName === 'style') continue;
    const p = vecProps(el, rules);
    for (const k of ['mask', 'clip-path', 'filter']) {
      if (p[k] && p[k] !== 'none') vecReject(`${k} is out of scope`);
    }
    if (p['stroke-dasharray'] && p['stroke-dasharray'] !== 'none') vecReject('stroke-dasharray');
    // Opacity is handled per shape: fill alpha maps to style key 16; only
    // faded PAINTED strokes reject (no known stroke-alpha key).
  }
  return { faces, rules };
}

function vecFraction(v, dflt) {
  if (v === null || v === undefined || v.trim() === '') return dflt;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) vecReject(`bad gradient coordinate ${v}`);
  return v.trim().endsWith('%') ? n / 100 : n;
}

function vecGradient(doc, url, rules) {
  const m = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/.exec(url);
  if (!m) vecReject(`unsupported paint ${url}`);
  const g = doc.querySelector(`[id="${m[1].replace(/"/g, '\\"')}"]`);
  if (!g || (g.localName !== 'linearGradient' && g.localName !== 'radialGradient')) {
    vecReject(`paint reference ${url} is not a gradient`);
  }
  if (g.getAttribute('gradientTransform')) vecReject('gradientTransform');
  if (g.getAttribute('gradientUnits') === 'userSpaceOnUse') vecReject('userSpaceOnUse gradient');
  if (g.getAttribute('href') || g.getAttributeNS('http://www.w3.org/1999/xlink', 'href')) {
    vecReject('gradient href inheritance');
  }
  const stops = [];
  for (const stop of g.querySelectorAll(':scope > stop')) {
    // Full cascade so class-styled stops resolve (else they'd silently go black).
    const p = vecProps(stop, rules);
    if (p['stop-opacity'] !== undefined && parseFloat(p['stop-opacity']) !== 1) {
      vecReject('partial stop-opacity');
    }
    const offset = Math.min(1, Math.max(0, vecFraction(stop.getAttribute('offset'), 0)));
    stops.push([vecColor(p['stop-color'] === undefined ? '#000000' : p['stop-color']), offset]);
  }
  if (stops.length < 2) vecReject('gradient needs at least two stops');
  if (g.localName === 'radialGradient') {
    const near = (v, want) => Math.abs(vecFraction(g.getAttribute(v), 0.5) - want) < 1e-6;
    if (!near('cx', 0.5) || !near('cy', 0.5) || !near('r', 0.5)) vecReject('off-center radial gradient');
    const fx = g.getAttribute('fx');
    const fy = g.getAttribute('fy');
    if ((fx !== null && Math.abs(vecFraction(fx, 0.5) - 0.5) > 1e-6) ||
        (fy !== null && Math.abs(vecFraction(fy, 0.5) - 0.5) > 1e-6)) {
      vecReject('focal radial gradient');
    }
    return { type: 2, stops, angle: 0 };
  }
  const x1 = vecFraction(g.getAttribute('x1'), 0);
  const y1 = vecFraction(g.getAttribute('y1'), 0);
  const x2 = vecFraction(g.getAttribute('x2'), 1);
  const y2 = vecFraction(g.getAttribute('y2'), 0);
  return { type: 1, stops, angle: Math.atan2(y2 - y1, x2 - x1) };
}

// Inheritable paint/text state, resolved lazily so unused values never
// reject. `opacity` is not an inherited property — it composites: each
// element's opacity multiplies into alphaMul on the way down. (For
// overlapping siblings under a translucent group this differs subtly from
// true group compositing; accepted, per-shape alpha is the format's model.)
function vecPaint(props, inherited) {
  const out = { ...inherited };
  for (const k of VEC_INHERITED) {
    if (props[k] !== undefined) out[k] = props[k];
  }
  const opacity = props.opacity !== undefined ? parseFloat(props.opacity) : 1;
  out.alphaMul = (inherited.alphaMul || 1) * (Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1);
  return out;
}

function vecFreshId() {
  let hex = '';
  for (const b of crypto.getRandomValues(new Uint8Array(11))) hex += (b & 15).toString(16);
  return `g${hex}_0_${Math.floor(Math.random() * 90 + 10)}`;
}

function vecGuid() {
  const hex = (n) => {
    let s = '';
    for (const b of crypto.getRandomValues(new Uint8Array(n))) s += (b & 15).toString(16);
    return s;
  };
  return `${hex(8)}-ffff-${hex(4)}-${hex(4)}-${hex(12)}`;
}

function vecStyleSet(style, key, value) {
  const i = style.indexOf(key);
  if (i >= 0) style[i + 1] = value;
  else style.push(key, value);
}

function vecStyleDelete(style, key) {
  const i = style.indexOf(key);
  if (i >= 0) style.splice(i, 2);
}

// Segment stream (M/L/C/Z, user units) → Slides op/coord streams through the
// full matrix, with L and C runs chained (proven by probe m-chain).
function vecEmitPath(segments, matrix) {
  const ops = [];
  const coords = [];
  const push = (x, y) => {
    const [tx, ty] = matApply(matrix, x, y);
    coords.push(Math.round(tx), Math.round(ty));
  };
  for (const seg of segments) {
    const verb = seg[0];
    if (verb === 'M') {
      ops.push(0, 2);
      push(seg[1], seg[2]);
    } else if (verb === 'Z') {
      ops.push(5, 0);
    } else {
      const op = verb === 'L' ? 1 : 3;
      const n = verb === 'L' ? 2 : 6;
      if (ops.length >= 2 && ops[ops.length - 2] === op) ops[ops.length - 1] += n;
      else ops.push(op, n);
      for (let i = 1; i < seg.length; i += 2) push(seg[i], seg[i + 1]);
    }
  }
  return { ops, coords };
}

// Flatten M/L/C/Z segments into per-subpath point rings (cubics sampled at a
// fixed resolution — only used for overlap topology, not the emitted path).
function vecSubpathRings(segments) {
  const subs = [];
  let cur = null;
  let px = 0;
  let py = 0;
  for (const seg of segments) {
    if (seg[0] === 'M') {
      cur = [[seg[1], seg[2]]];
      subs.push(cur);
      px = seg[1];
      py = seg[2];
    } else if (seg[0] === 'L' && cur) {
      cur.push([seg[1], seg[2]]);
      px = seg[1];
      py = seg[2];
    } else if (seg[0] === 'C' && cur) {
      const [x0, y0] = [px, py];
      for (let k = 1; k <= 12; k++) {
        const t = k / 12;
        const a = 1 - t;
        cur.push([
          a * a * a * x0 + 3 * a * a * t * seg[1] + 3 * a * t * t * seg[3] + t * t * t * seg[5],
          a * a * a * y0 + 3 * a * a * t * seg[2] + 3 * a * t * t * seg[4] + t * t * t * seg[6],
        ]);
      }
      px = seg[5];
      py = seg[6];
    }
  }
  return subs.filter((s) => s.length >= 3);
}

const VEC_CLIP_SCALE = 100;

function vecRingsToClipper(segments) {
  return vecSubpathRings(segments).map((pts) =>
    pts.map(([x, y]) => ({ X: Math.round(x * VEC_CLIP_SCALE), Y: Math.round(y * VEC_CLIP_SCALE) })));
}

function vecFilledArea(paths, rule) {
  const simp = ClipperLib.Clipper.SimplifyPolygons(paths, rule);
  return simp.reduce((a, r) => a + Math.abs(ClipperLib.Clipper.Area(r)), 0);
}

// Slides fills freeforms evenodd; SVG default is nonzero. They diverge only
// when a path overlaps itself — same-winding overlapping subpaths (union
// idiom), or a single self-intersecting / keyhole contour (a counter reached
// through a zero-width slit, common in logo letter outlines). Detect that by
// comparing the nonzero- and evenodd-filled areas of the same flattened
// contours: equal → the rules agree, emit exact béziers untouched; differ →
// normalize. Catches keyholes a pairwise-subpath test misses, and never
// false-fires on adjacent-but-disjoint shapes (their areas match).
function vecNeedsEvenoddFix(segments) {
  const paths = vecRingsToClipper(segments);
  if (paths.length < 1) return false;
  const nz = vecFilledArea(paths, ClipperLib.PolyFillType.pftNonZero);
  const eo = vecFilledArea(paths, ClipperLib.PolyFillType.pftEvenOdd);
  return nz > 0 && Math.abs(nz - eo) > nz * 0.001;
}

// Normalize a nonzero-fill path into evenodd-safe M/L/Z rings (Clipper, as
// with glyphs). Flattens curves — acceptable at slide scale, and only used on
// the rare path whose nonzero fill differs from evenodd.
function vecNormalizeFill(segments) {
  const S = VEC_CLIP_SCALE;
  const clean = ClipperLib.Clipper.SimplifyPolygons(
    vecRingsToClipper(segments), ClipperLib.PolyFillType.pftNonZero);
  const out = [];
  for (const ring of clean) {
    if (ring.length < 3) continue;
    out.push(['M', ring[0].X / S, ring[0].Y / S]);
    for (let i = 1; i < ring.length; i++) out.push(['L', ring[i].X / S, ring[i].Y / S]);
    out.push(['Z']);
  }
  return out;
}

// <text> → glyph-outline segments via the resolved face. Rejects the text
// features we can't lay out; whitespace-only content renders nothing.
async function vecTextSegments(ctx, el, paint) {
  if (el.children.length > 0) vecReject('<text> with child elements');
  for (const attr of ['dx', 'dy', 'rotate', 'textLength']) {
    if (el.getAttribute(attr) !== null) vecReject(`text ${attr}`);
  }
  if (paint['letter-spacing'] !== undefined && paint['letter-spacing'] !== 'normal') {
    vecReject('letter-spacing');
  }
  const content = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!content) return [];
  const size = parseFloat(paint['font-size']);
  if (!Number.isFinite(size) || size <= 0) vecReject('bad font-size');
  const font = await ctx.resolveFont({
    family: paint['font-family'] || '',
    weight: paint['font-weight'] || '400',
  });
  if (!font) vecReject('no font available');
  const x = parseFloat(el.getAttribute('x') || '0') || 0;
  const y = parseFloat(el.getAttribute('y') || '0') || 0;
  const anchor = paint['text-anchor'] || 'start';
  let ax = x;
  if (anchor === 'middle' || anchor === 'end') {
    const w = font.getAdvanceWidth(content, size, { kerning: true });
    ax = anchor === 'middle' ? x - w / 2 : x - w;
  }
  // Flatten + normalize the WHOLE RUN together (fonts.js): fonts are authored
  // for nonzero fill and overlap freely — contours within a glyph AND, in
  // connecting scripts (Lobster), across adjacent glyphs. One Clipper pass
  // over every contour unions all of it into evenodd-safe rings; per-glyph
  // scope would leave inter-glyph joins notched.
  const combined = font.getPath(content, ax, y, size, { kerning: true });
  try {
    return glyphCommandsToSegments(combined.commands);
  } catch (err) {
    vecReject(`glyph union failed: ${err.message}`);
  }
}

async function vecWalk(ctx, el, matrix, inherited, shapes) {
  for (const child of el.children) {
    const name = child.localName;
    if (VEC_SKIP_ELEMENTS.has(name)) continue;
    const props = vecProps(child, ctx.rules);
    const paint = vecPaint(props, inherited);
    const local = parseTransform(child.getAttribute('transform'));
    if (!local) vecReject('unsupported transform');
    const m = matMultiply(matrix, local);
    if (name === 'g' || name === 'a') {
      await vecWalk(ctx, child, m, paint, shapes);
      continue;
    }
    if (name === 'text') {
      const segments = await vecTextSegments(ctx, child, paint);
      // isText: union output is already evenodd-safe; outer rings of one
      // letterform can share bboxes, so the nonzero-union check must not run.
      if (segments.length) shapes.push({ segments, matrix: m, paint, isText: true });
      continue;
    }
    const segments = shapeToSegments(child);
    if (segments === null) {
      if (child.children.length === 0 && !name.match(/^(rect|circle|ellipse|line|polyline|polygon|path)$/)) {
        continue; // unknown empty element renders nothing in SVG too
      }
      vecReject(`unconvertible <${name}>`);
    }
    if (segments.length === 0) continue; // degenerate: renders nothing
    shapes.push({ segments, matrix: m, paint });
  }
}

async function vecConvert(svgText, opts) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg') vecReject('not valid SVG');
  const { faces: embeddedFaces, rules } = vecPreScan(root);
  const ctx = {
    doc,
    rules,
    resolveFont: opts.resolveFont
      ? (spec) => opts.resolveFont(spec, embeddedFaces)
      : (spec) => defaultResolveFont(spec, embeddedFaces, opts.fetchFont),
  };

  const size = resolveSize(root);
  const vbAttr = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const vb = vbAttr.length === 4 && vbAttr[2] > 0 && vbAttr[3] > 0
    ? vbAttr
    : [0, 0, size.width, size.height];
  const sx = (size.width / vb[2]) * VEC_SCALE;
  const sy = (size.height / vb[3]) * VEC_SCALE;
  const rootTransform = parseTransform(root.getAttribute('transform'));
  if (!rootTransform) vecReject('unsupported transform');
  const rootMatrix = matMultiply(
    [sx, 0, 0, sy, VEC_PASTE_X - vb[0] * sx, VEC_PASTE_Y - vb[1] * sy],
    rootTransform
  );

  const shapes = [];
  // SVG defaults, then the root <svg>'s own inherited paint/text props layered
  // on top (Serif/Affinity put fill-rule:evenodd here; children inherit it).
  const rootInherited = vecPaint(vecProps(root, rules), {
    fill: 'black',
    stroke: 'none',
    'stroke-width': '1',
    'fill-rule': 'nonzero',
    'fill-opacity': '1',
    'stroke-opacity': '1',
    alphaMul: 1,
    'font-family': '',
    'font-size': '16',
    'font-weight': '400',
    'text-anchor': 'start',
  });
  await vecWalk(ctx, root, rootMatrix, rootInherited, shapes);
  if (!shapes.length) vecReject('nothing convertible');

  const commands = [];
  const childIds = [];
  for (const shape of shapes) {
    // When a nonzero path's fill differs from evenodd (overlap / keyhole /
    // self-intersection), normalize it so it doesn't notch under Slides'
    // evenodd fill. A stroked such path would stroke the merged outline (not
    // the original contours), so that rare case falls back to PNG instead.
    let segments = shape.segments;
    const isFilled = segments[0][0] === 'M' &&
      !(segments.length === 2 && segments[1][0] === 'L');
    if (!shape.isText && isFilled && shape.paint.fill !== 'none' &&
        (shape.paint['fill-rule'] || 'nonzero') !== 'evenodd' &&
        vecNeedsEvenoddFix(segments)) {
      if (shape.paint.stroke !== 'none') vecReject('stroked self-overlapping path');
      segments = vecNormalizeFill(segments);
    }
    const { ops, coords } = vecEmitPath(segments, shape.matrix);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < coords.length; i += 2) {
      minX = Math.min(minX, coords[i]);
      maxX = Math.max(maxX, coords[i]);
      minY = Math.min(minY, coords[i + 1]);
      maxY = Math.max(maxY, coords[i + 1]);
    }
    for (let i = 0; i < coords.length; i += 2) {
      coords[i] -= minX;
      coords[i + 1] -= minY;
    }

    const style = JSON.parse(JSON.stringify(VECTOR_TEMPLATE.shapeCmd[4]));
    vecStyleSet(style, 12, [[1, 1, ops, coords, [], 0]]);
    vecStyleSet(style, 8, maxX - minX);
    vecStyleSet(style, 9, maxY - minY);

    const alphaOf = (prop) => {
      const v = shape.paint[prop] !== undefined ? parseFloat(shape.paint[prop]) : 1;
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    };
    const fill = shape.paint.fill;
    const fillAlpha = (shape.paint.alphaMul || 1) * alphaOf('fill-opacity');
    const fillsArea = segments[0][0] === 'M' &&
      !(segments.length === 2 && segments[1][0] === 'L'); // bare <line> never fills
    if (fill === 'none' || !fillsArea) {
      vecStyleSet(style, 14, 0);
    } else if (/^url\(/.test(fill)) {
      if (fillAlpha !== 1) vecReject('translucent gradient fill'); // no known key
      const g = vecGradient(doc, fill, rules);
      vecStyleSet(style, 14, 1);
      vecStyleSet(style, 15, g.stops[0][0]);
      vecStyleSet(style, 60, g.type);
      vecStyleSet(style, 61, g.stops);
      vecStyleSet(style, 62, g.angle);
      if (g.type === 2) vecStyleSet(style, 73, 1);
      vecStyleSet(style, 145, 1);
    } else {
      const c = vecColorAlpha(fill);
      vecStyleSet(style, 14, 1);
      vecStyleSet(style, 15, c.hex);
      const a = fillAlpha * c.alpha;
      if (a < 1) vecStyleSet(style, 16, Math.round(a * 1000) / 1000); // key 16 = fill opacity
    }

    if (shape.paint.stroke === 'none') {
      vecStyleSet(style, 18, 0);
      vecStyleDelete(style, 19);
    } else {
      if ((shape.paint.alphaMul || 1) * alphaOf('stroke-opacity') !== 1) {
        vecReject('faded stroke'); // no known stroke-alpha key
      }
      const width = parseFloat(shape.paint['stroke-width']);
      if (!Number.isFinite(width) || width < 0) vecReject('bad stroke-width');
      const det = Math.abs(shape.matrix[0] * shape.matrix[3] - shape.matrix[1] * shape.matrix[2]);
      vecStyleSet(style, 19, vecColor(shape.paint.stroke));
      vecStyleSet(style, 22, Math.round(width * Math.sqrt(det)));
    }

    const id = vecFreshId();
    childIds.push(id);
    commands.push([3, id, 138, [1, 0, 0, 1, minX, minY], style, 'p']);
  }

  // Wrap a multi-shape paste in one group so it drags/scales/selects as a
  // single object (structure per research/dumps p-group: children keep
  // parent 'p'; the group command carries the child-id list). Cmd 2 =
  // [id, childIds, identity affine, parent].
  if (childIds.length > 1) {
    commands.push([2, vecFreshId(), childIds, [1, 0, 0, 1, 0, 0], 'p']);
  }

  const data = {
    resolved: commands,
    unresolved: JSON.parse(JSON.stringify(commands)),
    ...VECTOR_TEMPLATE.dataSkeleton,
  };
  const wrapped = JSON.stringify({
    dih: VECTOR_TEMPLATE.envelope.dih,
    data: JSON.stringify(data),
    dct: 'punch',
    ds: VECTOR_TEMPLATE.envelope.ds,
    cses: VECTOR_TEMPLATE.envelope.cses,
    sm: VECTOR_TEMPLATE.envelope.sm,
  });
  return {
    'text/plain': ' ',
    'text/html': VECTOR_TEMPLATE.html.replace(/docs-internal-guid-TEMPLATE/g, `docs-internal-guid-${vecGuid()}`),
    [VEC_TYPE]: wrapped,
  };
}
