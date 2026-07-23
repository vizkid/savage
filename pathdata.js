'use strict';

// Pure SVG geometry: transform matrices, path-data parsing, and basic-shape →
// path synthesis. Everything normalizes to absolute M/L/C/Z segments so the
// converter (vectorize.js) deals with exactly four verbs. No extension APIs,
// no page state; loaded by the content script and the unit test page.

// Affine matrices use SVG order [a, b, c, d, e, f]:
// x' = a·x + c·y + e, y' = b·x + d·y + f.

const MAT_IDENTITY = [1, 0, 0, 1, 0, 0];

// m1 ∘ m2: apply m2 first, then m1.
function matMultiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Parses an SVG transform list. Returns a matrix, or null on anything
// malformed (callers treat null as out-of-scope → PNG fallback).
function parseTransform(str) {
  if (!str || !str.trim()) return MAT_IDENTITY;
  let m = MAT_IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  let consumed = 0;
  while ((match = re.exec(str)) !== null) {
    if (str.slice(consumed, match.index).trim() !== '' &&
        str.slice(consumed, match.index).trim() !== ',') return null;
    consumed = re.lastIndex;
    const args = match[2].trim().split(/[\s,]+/).filter((s) => s !== '').map(Number);
    if (args.some((n) => !Number.isFinite(n))) return null;
    const rad = (deg) => (deg * Math.PI) / 180;
    let t;
    switch (match[1]) {
      case 'matrix':
        if (args.length !== 6) return null;
        t = args;
        break;
      case 'translate':
        if (args.length < 1 || args.length > 2) return null;
        t = [1, 0, 0, 1, args[0], args[1] || 0];
        break;
      case 'scale':
        if (args.length < 1 || args.length > 2) return null;
        t = [args[0], 0, 0, args.length === 2 ? args[1] : args[0], 0, 0];
        break;
      case 'rotate': {
        if (args.length !== 1 && args.length !== 3) return null;
        const a = rad(args[0]);
        t = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        if (args.length === 3) {
          t = matMultiply(matMultiply([1, 0, 0, 1, args[1], args[2]], t),
            [1, 0, 0, 1, -args[1], -args[2]]);
        }
        break;
      }
      case 'skewX':
        if (args.length !== 1) return null;
        t = [1, 0, Math.tan(rad(args[0])), 1, 0, 0];
        break;
      case 'skewY':
        if (args.length !== 1) return null;
        t = [1, Math.tan(rad(args[0])), 0, 1, 0, 0];
        break;
    }
    m = matMultiply(m, t);
  }
  if (str.slice(consumed).trim() !== '') return null;
  return m;
}

// --- curves ---

// Quarter-arc cubic control-point factor (also exact for quarter ellipses).
const KAPPA = 0.5522847498307936;

// One elliptical-arc slice (≤ 90°) → a cubic: controls sit at
// start/end + alpha·tangent in unit-circle space, then map through the
// ellipse radii and x-axis rotation.
function arcSlice(cx, cy, rx, ry, cosPhi, sinPhi, t1, t2) {
  const alpha = (4 / 3) * Math.tan((t2 - t1) / 4);
  const map = (ux, uy) => [
    cx + cosPhi * rx * ux - sinPhi * ry * uy,
    cy + sinPhi * rx * ux + cosPhi * ry * uy,
  ];
  const [cp1x, cp1y] = map(Math.cos(t1) - alpha * Math.sin(t1), Math.sin(t1) + alpha * Math.cos(t1));
  const [cp2x, cp2y] = map(Math.cos(t2) + alpha * Math.sin(t2), Math.sin(t2) - alpha * Math.cos(t2));
  const [ex, ey] = map(Math.cos(t2), Math.sin(t2));
  return ['C', cp1x, cp1y, cp2x, cp2y, ex, ey];
}

// SVG endpoint arc → cubic segments (W3C implementation notes, F.6).
function arcToCubics(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [['L', x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  if (num < 0) num = 0;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(num / den);
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    return sign * Math.acos(Math.min(1, Math.max(-1, dot / len)));
  };
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const slices = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const out = [];
  for (let i = 0; i < slices; i++) {
    out.push(arcSlice(cx, cy, rx, ry, cosPhi, sinPhi,
      t1 + (dTheta * i) / slices, t1 + (dTheta * (i + 1)) / slices));
  }
  // Pin the final endpoint exactly (numeric drift otherwise).
  const last = out[out.length - 1];
  last[5] = x2;
  last[6] = y2;
  return out;
}

// --- path data ---

// Parses a d attribute into absolute segments using only M/L/C/Z.
// H/V → L; S/Q/T → C (quadratics lifted by 2/3); A → cubic slices.
// Returns null on any malformed input.
function parsePathD(d) {
  if (typeof d !== 'string' || !d.trim()) return null;
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g);
  if (!tokens || tokens.join('').replace(/[\s,]/g, '').length !==
      d.replace(/[\s,]/g, '').length) return null;
  const out = [];
  let i = 0;
  let cmd = null;
  let cx = 0; // current point
  let cy = 0;
  let sx = 0; // subpath start
  let sy = 0;
  let pcx = null; // previous cubic control (for S)
  let pqx = null; // previous quadratic control (for T)
  let pqy = null;
  let pcy = null;
  const num = () => {
    const n = Number(tokens[i++]);
    if (!Number.isFinite(n)) throw new Error('bad number');
    return n;
  };
  const quadToCubic = (qx, qy, x, y) => ['C',
    cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy),
    x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y];
  try {
    while (i < tokens.length) {
      if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
      else if (cmd === null) return null;
      else if (cmd === 'M') cmd = 'L'; // implicit repeats
      else if (cmd === 'm') cmd = 'l';
      const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
      const C = cmd.toUpperCase();
      let nqx = null;
      let nqy = null;
      let ncx = null;
      let ncy = null;
      switch (C) {
        case 'M': {
          const x = num() + (rel ? cx : 0);
          const y = num() + (rel ? cy : 0);
          out.push(['M', x, y]);
          cx = sx = x;
          cy = sy = y;
          break;
        }
        case 'L': {
          const x = num() + (rel ? cx : 0);
          const y = num() + (rel ? cy : 0);
          out.push(['L', x, y]);
          cx = x;
          cy = y;
          break;
        }
        case 'H': {
          const x = num() + (rel ? cx : 0);
          out.push(['L', x, cy]);
          cx = x;
          break;
        }
        case 'V': {
          const y = num() + (rel ? cy : 0);
          out.push(['L', cx, y]);
          cy = y;
          break;
        }
        case 'C': {
          const x1 = num() + (rel ? cx : 0);
          const y1 = num() + (rel ? cy : 0);
          const x2 = num() + (rel ? cx : 0);
          const y2 = num() + (rel ? cy : 0);
          const x = num() + (rel ? cx : 0);
          const y = num() + (rel ? cy : 0);
          out.push(['C', x1, y1, x2, y2, x, y]);
          ncx = x2;
          ncy = y2;
          cx = x;
          cy = y;
          break;
        }
        case 'S': {
          const x2 = num() + (rel ? cx : 0);
          const y2 = num() + (rel ? cy : 0);
          const x = num() + (rel ? cx : 0);
          const y = num() + (rel ? cy : 0);
          const x1 = pcx === null ? cx : 2 * cx - pcx;
          const y1 = pcy === null ? cy : 2 * cy - pcy;
          out.push(['C', x1, y1, x2, y2, x, y]);
          ncx = x2;
          ncy = y2;
          cx = x;
          cy = y;
          break;
        }
        case 'Q': {
          const qx = num() + (rel ? cx : 0);
          const qy = num() + (rel ? cy : 0);
          const x = num() + (rel ? cx : 0);
          const y = num() + (rel ? cy : 0);
          out.push(quadToCubic(qx, qy, x, y));
          nqx = qx;
          nqy = qy;
          cx = x;
          cy = y;
          break;
        }
        case 'T': {
          const qx = pqx === null ? cx : 2 * cx - pqx;
          const qy = pqy === null ? cy : 2 * cy - pqy;
          const x = num() + (rel ? cx : 0);
          const y = num() + (rel ? cy : 0);
          out.push(quadToCubic(qx, qy, x, y));
          nqx = qx;
          nqy = qy;
          cx = x;
          cy = y;
          break;
        }
        case 'A': {
          const rx = num();
          const ry = num();
          const rot = num();
          const laf = num();
          const swf = num();
          const x = num() + (rel ? cx : 0);
          const y = num() + (rel ? cy : 0);
          if ((laf !== 0 && laf !== 1) || (swf !== 0 && swf !== 1)) return null;
          for (const seg of arcToCubics(cx, cy, rx, ry, rot, laf, swf, x, y)) out.push(seg);
          cx = x;
          cy = y;
          break;
        }
        case 'Z': {
          out.push(['Z']);
          cx = sx;
          cy = sy;
          break;
        }
        default:
          return null;
      }
      pqx = nqx;
      pqy = nqy;
      pcx = ncx;
      pcy = ncy;
    }
  } catch (_) {
    return null;
  }
  return out.length ? out : null;
}

// --- basic shapes → segments ---

function ellipseSegments(cxc, cyc, rx, ry) {
  const k = KAPPA;
  return [
    ['M', cxc + rx, cyc],
    ['C', cxc + rx, cyc + k * ry, cxc + k * rx, cyc + ry, cxc, cyc + ry],
    ['C', cxc - k * rx, cyc + ry, cxc - rx, cyc + k * ry, cxc - rx, cyc],
    ['C', cxc - rx, cyc - k * ry, cxc - k * rx, cyc - ry, cxc, cyc - ry],
    ['C', cxc + k * rx, cyc - ry, cxc + rx, cyc - k * ry, cxc + rx, cyc],
    ['Z'],
  ];
}

function roundedRectSegments(x, y, w, h, rx, ry) {
  return [
    ['M', x + rx, y],
    ['L', x + w - rx, y],
    ['C', x + w - rx + KAPPA * rx, y, x + w, y + ry - KAPPA * ry, x + w, y + ry],
    ['L', x + w, y + h - ry],
    ['C', x + w, y + h - ry + KAPPA * ry, x + w - rx + KAPPA * rx, y + h, x + w - rx, y + h],
    ['L', x + rx, y + h],
    ['C', x + rx - KAPPA * rx, y + h, x, y + h - ry + KAPPA * ry, x, y + h - ry],
    ['L', x, y + ry],
    ['C', x, y + ry - KAPPA * ry, x + rx - KAPPA * rx, y, x + rx, y],
    ['Z'],
  ];
}

function pointsToSegments(pointsAttr, close) {
  const nums = (pointsAttr || '').trim().split(/[\s,]+/).filter((s) => s !== '').map(Number);
  if (nums.length < 4 || nums.length % 2 !== 0 || nums.some((n) => !Number.isFinite(n))) return null;
  const out = [['M', nums[0], nums[1]]];
  for (let i = 2; i < nums.length; i += 2) out.push(['L', nums[i], nums[i + 1]]);
  if (close) out.push(['Z']);
  return out;
}

// Basic shape element → absolute M/L/C/Z segments (null = not a basic shape
// or malformed). Degenerate (zero-extent) shapes return [] — render nothing.
function shapeToSegments(el) {
  const f = (name, dflt) => {
    const v = el.getAttribute(name);
    if (v === null || v.trim() === '') return dflt;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
  };
  switch (el.localName) {
    case 'rect': {
      const x = f('x', 0);
      const y = f('y', 0);
      const w = f('width', 0);
      const h = f('height', 0);
      let rx = f('rx', NaN);
      let ry = f('ry', NaN);
      if ([x, y, w, h].some(Number.isNaN)) return null;
      if (w <= 0 || h <= 0) return [];
      if (Number.isNaN(rx) && Number.isNaN(ry)) rx = ry = 0;
      else if (Number.isNaN(rx)) rx = ry;
      else if (Number.isNaN(ry)) ry = rx;
      if (Number.isNaN(rx) || Number.isNaN(ry)) return null;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (rx === 0 || ry === 0) {
        return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
      }
      return roundedRectSegments(x, y, w, h, rx, ry);
    }
    case 'circle': {
      const cx = f('cx', 0);
      const cy = f('cy', 0);
      const r = f('r', 0);
      if ([cx, cy, r].some(Number.isNaN)) return null;
      return r <= 0 ? [] : ellipseSegments(cx, cy, r, r);
    }
    case 'ellipse': {
      const cx = f('cx', 0);
      const cy = f('cy', 0);
      const rx = f('rx', 0);
      const ry = f('ry', 0);
      if ([cx, cy, rx, ry].some(Number.isNaN)) return null;
      return rx <= 0 || ry <= 0 ? [] : ellipseSegments(cx, cy, rx, ry);
    }
    case 'line': {
      const x1 = f('x1', 0);
      const y1 = f('y1', 0);
      const x2 = f('x2', 0);
      const y2 = f('y2', 0);
      if ([x1, y1, x2, y2].some(Number.isNaN)) return null;
      return [['M', x1, y1], ['L', x2, y2]];
    }
    case 'polyline':
      return pointsToSegments(el.getAttribute('points'), false);
    case 'polygon':
      return pointsToSegments(el.getAttribute('points'), true);
    case 'path':
      return parsePathD(el.getAttribute('d'));
    default:
      return null;
  }
}
