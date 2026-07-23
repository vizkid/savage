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
];
const VEC_INHERITED = [
  'fill', 'stroke', 'stroke-width', 'fill-rule',
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
function vecColor(str) {
  if (!vecColorCtx) vecColorCtx = document.createElement('canvas').getContext('2d');
  vecColorCtx.fillStyle = '#000000';
  vecColorCtx.fillStyle = str;
  const v = vecColorCtx.fillStyle;
  if (!/^#[0-9a-f]{6}$/i.test(v)) vecReject(`unsupported color ${str}`);
  // Invalid keywords leave the reset value; catch obvious ones.
  if (v === '#000000' && str.trim() !== '' && !/^(#0*|black|rgb\(\s*0[\s,]+0[\s,]+0\s*\))/i.test(str.trim())) {
    vecReject(`unrecognized color ${str}`);
  }
  return v.toUpperCase();
}

// Merged presentation attributes + style-attribute declarations (style wins).
function vecProps(el) {
  const p = {};
  for (const name of VEC_PAINT_PROPS) {
    const v = el.getAttribute(name);
    if (v !== null) p[name] = v.trim();
  }
  const style = el.getAttribute('style');
  if (style) {
    for (const decl of style.split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) {
        const k = decl.slice(0, i).trim().toLowerCase();
        const v = decl.slice(i + 1).trim();
        if (v) p[k] = v;
      }
    }
  }
  return p;
}

// Rejects out-of-scope features document-wide; returns the Map of embedded
// @font-face faces collected from (font-face-only) <style> blocks.
function vecPreScan(root) {
  const embeddedFaces = new Map();
  const all = [root, ...root.querySelectorAll('*')];
  for (const el of all) {
    if (VEC_REJECT_ELEMENTS.has(el.localName)) vecReject(`<${el.localName}> is out of scope`);
    if (el !== root && el.localName === 'svg') vecReject('nested <svg>');
    if (el.localName === 'style') {
      const faces = fontFaceOnlyStyle(el.textContent || '');
      if (!faces) vecReject('<style> beyond @font-face');
      for (const [family, buf] of faces) embeddedFaces.set(family, buf);
      continue;
    }
    const p = vecProps(el);
    for (const k of ['mask', 'clip-path', 'filter']) {
      if (p[k] && p[k] !== 'none') vecReject(`${k} is out of scope`);
    }
    if (p['stroke-dasharray'] && p['stroke-dasharray'] !== 'none') vecReject('stroke-dasharray');
    for (const k of ['opacity', 'fill-opacity', 'stroke-opacity']) {
      if (p[k] !== undefined && parseFloat(p[k]) !== 1) vecReject(`partial ${k}`);
    }
  }
  return embeddedFaces;
}

function vecFraction(v, dflt) {
  if (v === null || v === undefined || v.trim() === '') return dflt;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) vecReject(`bad gradient coordinate ${v}`);
  return v.trim().endsWith('%') ? n / 100 : n;
}

function vecGradient(doc, url) {
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
    const p = { 'stop-color': stop.getAttribute('stop-color'), 'stop-opacity': stop.getAttribute('stop-opacity') };
    const style = stop.getAttribute('style');
    if (style) {
      for (const decl of style.split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) p[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
      }
    }
    if (p['stop-opacity'] !== null && p['stop-opacity'] !== undefined &&
        parseFloat(p['stop-opacity']) !== 1) vecReject('partial stop-opacity');
    const offset = Math.min(1, Math.max(0, vecFraction(stop.getAttribute('offset'), 0)));
    stops.push([vecColor(p['stop-color'] === null || p['stop-color'] === undefined ? '#000000' : p['stop-color']), offset]);
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

// Inheritable paint/text state, resolved lazily so unused values never reject.
function vecPaint(props, inherited) {
  const out = { ...inherited };
  for (const k of VEC_INHERITED) {
    if (props[k] !== undefined) out[k] = props[k];
  }
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

// Slides fills freeforms evenodd. A nonzero-rule path whose same-winding
// subpaths overlap would gain a hole it doesn't have in SVG → reject.
// Winding/bbox use segment anchor points; sign comparison is affine-invariant.
function vecCheckFillRule(segments) {
  const subs = [];
  let cur = null;
  for (const seg of segments) {
    if (seg[0] === 'M') {
      cur = { pts: [[seg[1], seg[2]]] };
      subs.push(cur);
    } else if (cur && seg[0] !== 'Z') {
      cur.pts.push([seg[seg.length - 2], seg[seg.length - 1]]);
    }
  }
  if (subs.length < 2) return;
  for (const s of subs) {
    let area = 0;
    const pts = s.pts;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      area += x1 * y2 - x2 * y1;
    }
    s.sign = Math.sign(area);
    s.bbox = pts.reduce(
      (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
      [Infinity, Infinity, -Infinity, -Infinity]
    );
  }
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const a = subs[i].bbox;
      const b = subs[j].bbox;
      const overlap = a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
      if (overlap && subs[i].sign !== 0 && subs[i].sign === subs[j].sign) {
        vecReject('nonzero fill with same-winding overlapping subpaths');
      }
    }
  }
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
  // Flatten + union PER GLYPH (fonts.js): overlapping same-winding contours
  // would notch under Slides' evenodd fill, but boolean ops carry float-snap
  // risk in thin regions — so glyphs whose contours don't overlap must never
  // pass through the clipper. Per-glyph scope keeps disjoint letterforms out.
  try {
    const segments = [];
    for (const glyphPath of font.getPaths(content, ax, y, size, { kerning: true })) {
      segments.push(...glyphCommandsToSegments(glyphPath.commands));
    }
    return segments;
  } catch (err) {
    vecReject(`glyph union failed: ${err.message}`);
  }
}

async function vecWalk(ctx, el, matrix, inherited, shapes) {
  for (const child of el.children) {
    const name = child.localName;
    if (VEC_SKIP_ELEMENTS.has(name)) continue;
    const props = vecProps(child);
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
  const embeddedFaces = vecPreScan(root);
  const ctx = {
    doc,
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
  await vecWalk(ctx, root, rootMatrix, {
    fill: 'black',
    stroke: 'none',
    'stroke-width': '1',
    'fill-rule': 'nonzero',
    'font-family': '',
    'font-size': '16',
    'font-weight': '400',
    'text-anchor': 'start',
  }, shapes);
  if (!shapes.length) vecReject('nothing convertible');

  const commands = [];
  for (const shape of shapes) {
    const { ops, coords } = vecEmitPath(shape.segments, shape.matrix);
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

    const fill = shape.paint.fill;
    const fillsArea = shape.segments[0][0] === 'M' &&
      !(shape.segments.length === 2 && shape.segments[1][0] === 'L'); // bare <line> never fills
    if (fill === 'none' || !fillsArea) {
      vecStyleSet(style, 14, 0);
    } else if (/^url\(/.test(fill)) {
      const g = vecGradient(doc, fill);
      vecStyleSet(style, 14, 1);
      vecStyleSet(style, 15, g.stops[0][0]);
      vecStyleSet(style, 60, g.type);
      vecStyleSet(style, 61, g.stops);
      vecStyleSet(style, 62, g.angle);
      if (g.type === 2) vecStyleSet(style, 73, 1);
      vecStyleSet(style, 145, 1);
    } else {
      vecStyleSet(style, 14, 1);
      vecStyleSet(style, 15, vecColor(fill));
    }

    if (shape.paint.stroke === 'none') {
      vecStyleSet(style, 18, 0);
      vecStyleDelete(style, 19);
    } else {
      const width = parseFloat(shape.paint['stroke-width']);
      if (!Number.isFinite(width) || width < 0) vecReject('bad stroke-width');
      const det = Math.abs(shape.matrix[0] * shape.matrix[3] - shape.matrix[1] * shape.matrix[2]);
      vecStyleSet(style, 19, vecColor(shape.paint.stroke));
      vecStyleSet(style, 22, Math.round(width * Math.sqrt(det)));
    }

    if (!shape.isText && (shape.paint['fill-rule'] || 'nonzero') !== 'evenodd' &&
        fill !== 'none' && fillsArea) {
      vecCheckFillRule(shape.segments);
    }

    commands.push([3, vecFreshId(), 138, [1, 0, 0, 1, minX, minY], style, 'p']);
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
