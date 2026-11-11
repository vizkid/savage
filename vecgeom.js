'use strict';

// Outline geometry on Clipper polygons: flattening segments into rings,
// nonzero→evenodd fill normalization (Slides fills freeforms evenodd), and
// clip-path regions with a containment test. Depends on pathdata.js
// (shapeToSegments, parseTransform, matApply/matMultiply) and vendor/clipper.js;
// vecReject lives in vectorize.js and is resolved at call time.

// Flatten M/L/C/Z segments into per-subpath point rings (cubics sampled at a
// fixed resolution — only used for overlap topology, not the emitted path).
function vecSubpathRings(segments, minPts = 3) {
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
  return subs.filter((s) => s.length >= minPts);
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

// --- clip paths (VECTOR2-SPEC "Clip paths that remove nothing") ---

// Containment slack. Rings flatten cubics into 12 chords each, which cuts
// inside a curve by up to ~0.2% of its radius, so the slack scales with the
// clip's size: 0.5% of its bbox diagonal, never under 0.5 CSS px (381 units
// per px). A fixed slack would swallow real cuts on small artwork.
const VEC_CLIP_TOL_MIN = 190;
const VEC_CLIP_TOL_FRAC = 0.005;
const VEC_CLIP_AREA_TOL = 381 * 381; // leftover area under 1 CSS px² is noise

// Segments under an affine matrix → integer Clipper rings in page units.
function vecPageRings(segments, matrix, minPts = 3) {
  return vecSubpathRings(segments, minPts).map((pts) => pts.map(([x, y]) => {
    const [px, py] = matApply(matrix, x, y);
    return { X: Math.round(px), Y: Math.round(py) };
  }));
}

function vecClipRule(...els) {
  for (const el of els) {
    const style = /(?:^|;)\s*clip-rule\s*:\s*(nonzero|evenodd)/.exec(el.getAttribute('style') || '');
    const v = style ? style[1] : el.getAttribute('clip-rule');
    if (v === 'evenodd') return ClipperLib.PolyFillType.pftEvenOdd;
    if (v === 'nonzero') return ClipperLib.PolyFillType.pftNonZero;
  }
  return ClipperLib.PolyFillType.pftNonZero;
}

// One <clipPath> child → [element holding the geometry, its local matrix].
// <use> resolves to a same-file basic shape, offset by its x/y.
function vecClipChildGeometry(kid, ctx) {
  let local = parseTransform(kid.getAttribute('transform'));
  if (!local) vecReject('clip child transform');
  if (kid.localName !== 'use') return [kid, local];
  const href = kid.getAttribute('href') ||
    kid.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
  const ref = /^#(.+)$/.exec(href.trim());
  const target = ref && ctx.doc.querySelector(`[id="${ref[1].replace(/"/g, '\\"')}"]`);
  if (!target) vecReject('clip <use> reference');
  const ux = parseFloat(kid.getAttribute('x') || '0') || 0;
  const uy = parseFloat(kid.getAttribute('y') || '0') || 0;
  const tt = parseTransform(target.getAttribute('transform'));
  if (!tt) vecReject('clip <use> target transform');
  local = matMultiply(matMultiply(local, [1, 0, 0, 1, ux, uy]), tt);
  return [target, local];
}

// clip-path="url(#id)" in user space m → the clip region as Clipper paths in
// page units (union of the children, each filled by its clip-rule).
function vecClipRegion(url, m, ctx) {
  const ref = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)$/.exec(url);
  if (!ref) vecReject('unsupported clip-path');
  const clip = ctx.doc.querySelector(`[id="${ref[1].replace(/"/g, '\\"')}"]`);
  if (!clip || clip.localName !== 'clipPath') vecReject('clip-path reference');
  if (clip.getAttribute('clipPathUnits') === 'objectBoundingBox') vecReject('objectBoundingBox clip');
  const clipM = parseTransform(clip.getAttribute('transform'));
  if (!clipM) vecReject('clipPath transform');
  const parts = [];
  for (const kid of clip.children) {
    if (kid.localName === 'title' || kid.localName === 'desc') continue;
    const [el, local] = vecClipChildGeometry(kid, ctx);
    const segments = shapeToSegments(el);
    if (segments === null) vecReject(`unsupported clip child <${el.localName}>`);
    if (!segments.length) continue;
    const rings = vecPageRings(segments, matMultiply(matMultiply(m, clipM), local));
    parts.push(...ClipperLib.Clipper.SimplifyPolygons(rings, vecClipRule(el, kid, clip)));
  }
  if (!parts.length) vecReject('empty clip region');
  return ClipperLib.Clipper.SimplifyPolygons(parts, ClipperLib.PolyFillType.pftNonZero);
}

function vecOffset(paths, delta, endType) {
  const co = new ClipperLib.ClipperOffset(2, 0.25 * 381);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, endType);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta);
  return out;
}

// True when every shape's painted area (fill, plus stroke grown by half its
// width) lies inside the clip region, grown by the size-scaled slack.
function vecClipContains(region, shapes) {
  const b = ClipperLib.Clipper.GetBounds(region);
  const tol = Math.max(VEC_CLIP_TOL_MIN, VEC_CLIP_TOL_FRAC * Math.hypot(b.right - b.left, b.bottom - b.top));
  const grown = vecOffset(region, tol, ClipperLib.EndType.etClosedPolygon);
  const painted = [];
  for (const sh of shapes) {
    painted.push(...vecPageRings(sh.segments, sh.matrix));
    const width = parseFloat(sh.paint.stroke === 'none' ? '0' : sh.paint['stroke-width']);
    if (width > 0) {
      const m = sh.matrix;
      const half = (width * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))) / 2;
      // etClosedLine strokes every edge, including an open path's implied
      // closing edge: a slight overestimate, which only errs toward PNG.
      const lines = vecPageRings(sh.segments, sh.matrix, 2);
      painted.push(...vecOffset(lines, half, ClipperLib.EndType.etClosedLine));
    }
  }
  if (!painted.length) return true;
  const c = new ClipperLib.Clipper();
  c.AddPaths(painted, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(grown, ClipperLib.PolyType.ptClip, true);
  const outside = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctDifference, outside,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const area = outside.reduce((a, r) => a + Math.abs(ClipperLib.Clipper.Area(r)), 0);
  return area <= VEC_CLIP_AREA_TOL;
}
