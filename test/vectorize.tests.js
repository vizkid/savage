'use strict';

// Contract tests for vectorize.js (svgToSliceClip). Numbers come from the
// pinned facts in research/FINDINGS.md: 381 units/CSS px, type 138, op streams
// 0/1/3/5 (op 3 chains 2n cubic coords), style keys 8/9/12/14/15/18/19/22 and
// 60/61/62/73/145, template-morph envelope. Uses NS from tests.js.

const VTYPE = 'application/x-vnd.google-docs-drawings-object+wrapped';
const PX = 36576; // paste origin: SVG top-left lands at (1", 0.5")
const PY = 18288;

const V = (inner, attrs = 'viewBox="0 0 100 100"') => `<svg ${NS} ${attrs}>${inner}</svg>`;

function unwrap(flavors) {
  assert(flavors && typeof flavors === 'object', 'converter returned null');
  const wrapper = JSON.parse(flavors[VTYPE]);
  const data = JSON.parse(wrapper.data);
  const cmd3 = (c) => ({ id: c[1], type: c[2], xf: c[3], style: c[4], parent: c[5] });
  // Converted shapes are type 138 freeforms; the connector anchor is a type-6
  // preset rect. Keep them separate so shape counts ignore the anchor.
  const shapes = data.resolved.filter((c) => c[0] === 3 && c[2] === 138).map(cmd3);
  const anchor = (data.resolved.find((c) => c[0] === 3 && c[2] === 6) || null);
  const groups = data.resolved.filter((c) => c[0] === 2);
  return { wrapper, data, shapes, anchor: anchor && cmd3(anchor), groups };
}
async function one(svg) {
  const { shapes } = unwrap(await svgToSliceClip(svg));
  assert(shapes.length === 1, `expected 1 shape, got ${shapes.length}`);
  return shapes[0];
}
function sv(shape, key) {
  const i = shape.style.indexOf(key);
  return i >= 0 ? shape.style[i + 1] : undefined;
}
function path12(shape) {
  const v = sv(shape, 12);
  assert(Array.isArray(v) && v[0], 'missing path (key 12)');
  return { ops: v[0][2], coords: v[0][3] };
}
function opPairs(ops) {
  const out = [];
  for (let i = 0; i < ops.length; i += 2) out.push([ops[i], ops[i + 1]]);
  return out;
}
function near(a, b, eps = 1.5) {
  return Math.abs(a - b) <= eps;
}
function arrNear(a, b, eps = 1.5) {
  return a.length === b.length && a.every((v, i) => near(v, b[i], eps));
}

// --- geometry: basic shapes ---

t('vec: rect → op 0/1/5 square, scaled 381/px, placed at paste origin', async () => {
  const s = await one(V('<rect x="10" y="20" width="40" height="30" fill="#ff0000"/>'));
  assert(s.type === 138, `type ${s.type}, want 138 (154 spline-smooths)`);
  assert(arrNear(s.xf, [1, 0, 0, 1, PX + 3810, PY + 7620]), `xf ${JSON.stringify(s.xf)}`);
  assert(near(sv(s, 8), 15240) && near(sv(s, 9), 11430), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
  const { ops, coords } = path12(s);
  assert(String(ops) === '0,2,1,6,5,0', `ops ${ops}`);
  assert(arrNear(coords, [0, 0, 15240, 0, 15240, 11430, 0, 11430]), `coords ${coords}`);
});

t('vec: width/height attrs rescale user units', async () => {
  const s = await one(V('<rect x="10" y="20" width="40" height="30" fill="#f00"/>',
    'width="200" height="200" viewBox="0 0 100 100"'));
  assert(near(s.xf[4], PX + 7620), `tx ${s.xf[4]}`);
  assert(near(sv(s, 8), 30480), `8 = ${sv(s, 8)}`);
});

t('vec: non-uniform viewBox scale applies per axis', async () => {
  const s = await one(V('<rect x="0" y="0" width="40" height="30" fill="#f00"/>',
    'width="200" height="100" viewBox="0 0 100 100"'));
  assert(near(sv(s, 8), 30480) && near(sv(s, 9), 11430), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
});

t('vec: viewBox min-x/min-y normalize to the paste origin', async () => {
  const s = await one(V('<rect x="-50" y="-50" width="10" height="10" fill="#f00"/>',
    'viewBox="-50 -50 100 100"'));
  assert(arrNear([s.xf[4], s.xf[5]], [PX, PY]), `origin ${s.xf[4]},${s.xf[5]}`);
});

t('vec: circle → one chained op-3 run of 4 cubics, closed', async () => {
  const s = await one(V('<circle cx="50" cy="50" r="40" fill="#00ff00"/>'));
  const { ops, coords } = path12(s);
  assert(String(ops) === '0,2,3,24,5,0', `ops ${ops}`);
  assert(near(sv(s, 8), 30480) && near(sv(s, 9), 30480), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
  assert(arrNear(coords.slice(0, 2), [30480, 15240]), `start ${coords.slice(0, 2)}`);
  assert(arrNear(coords.slice(-2), coords.slice(0, 2)), 'loop does not close on start');
});

t('vec: ellipse rx/ry scale independently', async () => {
  const s = await one(V('<ellipse cx="50" cy="50" rx="40" ry="20" fill="#00ff00"/>'));
  const { ops } = path12(s);
  assert(String(ops) === '0,2,3,24,5,0', `ops ${ops}`);
  assert(near(sv(s, 8), 30480) && near(sv(s, 9), 15240), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
});

t('vec: rounded rect → four corner cubics between edges, closed', async () => {
  const s = await one(V('<rect x="10" y="10" width="60" height="40" rx="10" fill="#f00"/>'));
  const pairs = opPairs(path12(s).ops);
  assert(pairs[0][0] === 0, 'must start with moveTo');
  assert(pairs[pairs.length - 1][0] === 5, 'must close');
  const cubicRuns = pairs.filter(([op]) => op === 3);
  assert(cubicRuns.length === 4, `${cubicRuns.length} corner runs, want 4`);
  cubicRuns.forEach(([, n]) => assert(n === 6, `corner run has ${n} coords, want 6`));
});

t('vec: line → open op-1, no fill, stroke mapped', async () => {
  const s = await one(V('<line x1="10" y1="10" x2="60" y2="40" stroke="#000000" stroke-width="2"/>'));
  const { ops, coords } = path12(s);
  assert(String(ops) === '0,2,1,2', `ops ${ops}`);
  assert(arrNear(coords, [0, 0, 19050, 11430]), `coords ${coords}`);
  assert(sv(s, 14) === 0, 'line must not fill');
  assert(sv(s, 19) === '#000000', `19 = ${sv(s, 19)}`);
  assert(near(sv(s, 22), 762), `22 = ${sv(s, 22)}`);
});

t('vec: polyline → open op-1 chain', async () => {
  const s = await one(V('<polyline points="0,0 50,0 50,50" fill="none" stroke="#112233"/>'));
  const { ops } = path12(s);
  assert(String(ops) === '0,2,1,4', `ops ${ops}`);
  assert(sv(s, 14) === 0, 'fill="none" must set 14:0');
  assert(sv(s, 19) === '#112233' && near(sv(s, 22), 381), 'default 1px stroke = 381');
});

t('vec: polygon → closed op-1 chain', async () => {
  const s = await one(V('<polygon points="0,0 50,0 25,40" fill="#123456"/>'));
  const { ops } = path12(s);
  assert(String(ops) === '0,2,1,4,5,0', `ops ${ops}`);
  assert(sv(s, 14) === 1 && sv(s, 15) === '#123456', 'polygon fills');
});

// --- geometry: path data ---

t('vec: path H/V/L normalize into one op-1 chain', async () => {
  const s = await one(V('<path d="M10 10 H60 V40 L10 40 Z" fill="#f00"/>'));
  const { ops, coords } = path12(s);
  assert(String(ops) === '0,2,1,6,5,0', `ops ${ops}`);
  assert(arrNear(coords, [0, 0, 19050, 0, 19050, 11430, 0, 11430]), `coords ${coords}`);
});

t('vec: consecutive cubics chain into one op-3 run', async () => {
  const s = await one(V('<path d="M0 0 C10 0 20 10 20 20 C20 30 10 40 0 40" fill="none" stroke="#000"/>'));
  const { ops } = path12(s);
  assert(String(ops) === '0,2,3,12', `ops ${ops}`);
});

t('vec: quadratic → exact cubic (2/3 control lift)', async () => {
  const s = await one(V('<path d="M0 0 Q30 0 30 30" fill="none" stroke="#000"/>'));
  const { ops, coords } = path12(s);
  assert(String(ops) === '0,2,3,6', `ops ${ops}`);
  assert(arrNear(coords, [0, 0, 7620, 0, 11430, 3810, 11430, 11430]), `coords ${coords}`);
});

t('vec: arc → cubic run(s) ending on the arc endpoint', async () => {
  const s = await one(V('<path d="M0 0 A20 20 0 0 1 20 20" fill="none" stroke="#000"/>'));
  const { ops, coords } = path12(s);
  const pairs = opPairs(ops);
  assert(pairs[0][0] === 0 && pairs.slice(1).every(([op]) => op === 3), `ops ${ops}`);
  const total = pairs.reduce((n, [, c]) => n + c, 0);
  assert(total === coords.length, `ops claim ${total} coords, stream has ${coords.length}`);
  let minX = Infinity;
  let minY = Infinity;
  for (let i = 0; i < coords.length; i += 2) {
    minX = Math.min(minX, coords[i]);
    minY = Math.min(minY, coords[i + 1]);
  }
  assert(arrNear(coords.slice(-2), [7620 - minX, 7620 - minY], 3), `arc end ${coords.slice(-2)}`);
});

t('vec: smooth cubics (S) extend the chained run', async () => {
  const s = await one(V('<path d="M0 0 C10 0 20 10 20 20 S30 40 40 40" fill="none" stroke="#000"/>'));
  const { ops } = path12(s);
  assert(String(ops) === '0,2,3,12', `ops ${ops}`);
});

// --- transforms ---

t('vec: nested <svg> viewport scales + positions its content', async () => {
  // Inner svg: viewBox 10×10 mapped to a 50×50 viewport at (20,20). A 10-unit
  // rect fills the inner viewBox → 50×50 user units at (20,20) in the outer.
  const s = await one(V('<svg x="20" y="20" width="50" height="50" viewBox="0 0 10 10">' +
    '<rect x="0" y="0" width="10" height="10" fill="#f00"/></svg>', 'viewBox="0 0 100 100"'));
  assert(arrNear([s.xf[4], s.xf[5]], [PX + 20 * 381, PY + 20 * 381], 3), `origin ${s.xf[4]},${s.xf[5]}`);
  assert(near(sv(s, 8), 50 * 381, 4) && near(sv(s, 9), 50 * 381, 4), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
});

t('vec: nested <svg> with no width/height fills the parent viewport (scraped wrapper)', async () => {
  // The BMC pattern: inner svg has only a viewBox; width/height default to the
  // parent viewport, so its viewBox scales up to fill it.
  const s = await one(V('<svg viewBox="0 0 25 25"><rect x="0" y="0" width="25" height="25" fill="#f00"/></svg>',
    'viewBox="0 0 100 100"'));
  assert(near(sv(s, 8), 100 * 381, 6) && near(sv(s, 9), 100 * 381, 6), `filled parent, 8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
});

t('vec: nested <svg> with preserveAspectRatio="slice" → null (would clip)', async () => {
  const svg = V('<svg width="50" height="50" viewBox="0 0 10 20" preserveAspectRatio="xMidYMid slice">' +
    '<rect width="10" height="20" fill="#f00"/></svg>', 'viewBox="0 0 100 100"');
  assert((await svgToSliceClip(svg)) === null, 'slice clips — must fall back to PNG');
});

t('vec: nested translate+scale bake into coords', async () => {
  const s = await one(V('<g transform="translate(10,10)"><g transform="scale(2)">' +
    '<rect x="0" y="0" width="10" height="10" fill="#f00"/></g></g>'));
  assert(arrNear([s.xf[4], s.xf[5]], [PX + 3810, PY + 3810]), `origin ${s.xf[4]},${s.xf[5]}`);
  assert(near(sv(s, 8), 7620) && near(sv(s, 9), 7620), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
});

t('vec: rotate bakes into coords (45° square grows bbox ×√2)', async () => {
  const s = await one(V('<rect x="0" y="0" width="10" height="10" fill="#f00" transform="rotate(45 5 5)"/>'));
  assert(near(sv(s, 8), 5388, 4) && near(sv(s, 9), 5388, 4), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
  const { ops } = path12(s);
  assert(String(ops) === '0,2,1,6,5,0', `ops ${ops}`);
});

// --- paint ---

// --- CSS <style> class/type styling (Illustrator/Figma exports) ---

t('vec: class selector fills the path', async () => {
  const s = await one(V('<defs><style>.cls-1{fill:#ea4335;}</style></defs>' +
    '<path class="cls-1" d="M0 0 H10 V10 H0 Z"/>'));
  assert(sv(s, 15) === '#EA4335', `15 = ${sv(s, 15)}`);
});

t('vec: type selector fills, class overrides type', async () => {
  const s = await one(V('<defs><style>path{fill:#111111;} .hi{fill:#00ff00;}</style></defs>' +
    '<path class="hi" d="M0 0 H10 V10 H0 Z"/>'));
  assert(sv(s, 15) === '#00FF00', `class must beat type, 15 = ${sv(s, 15)}`);
});

t('vec: inline style beats CSS class', async () => {
  const s = await one(V('<defs><style>.c{fill:#111111;}</style></defs>' +
    '<path class="c" style="fill:#00ff00" d="M0 0 H10 V10 H0 Z"/>'));
  assert(sv(s, 15) === '#00FF00', `15 = ${sv(s, 15)}`);
});

t('vec: CSS class beats presentation attribute', async () => {
  const s = await one(V('<defs><style>.c{fill:#00ff00;}</style></defs>' +
    '<path class="c" fill="#111111" d="M0 0 H10 V10 H0 Z"/>'));
  assert(sv(s, 15) === '#00FF00', `15 = ${sv(s, 15)}`);
});

t('vec: class stroke + width + fill-opacity via CSS', async () => {
  const s = await one(V('<defs><style>.c{fill:#f00;stroke:#00f;stroke-width:2;fill-opacity:0.5;}</style></defs>' +
    '<rect class="c" width="10" height="10"/>'));
  assert(sv(s, 15) === '#FF0000' && sv(s, 19) === '#0000FF', 'fill+stroke');
  assert(near(sv(s, 22), 762) && near(sv(s, 16), 0.5, 0.01), 'width + alpha');
});

t('vec: CSS classes co-exist with @font-face in one <style>', async () => {
  const s = await one(V(`<defs><style>@font-face{font-family:'X';src:url(${testFaceUri()});}` +
    '.c{fill:#123456;}</style></defs><rect class="c" width="10" height="10"/>'));
  assert(sv(s, 15) === '#123456', `15 = ${sv(s, 15)}`);
});

t('vec: harmless CSS props (clip-rule, stroke cosmetics) are ignored, not rejected', async () => {
  // ServiceNow / Adobe exports: .st0{fill-rule:evenodd;clip-rule:evenodd;fill:…}
  const s = await one(V('<defs><style>.st0{fill-rule:evenodd;clip-rule:evenodd;fill:#62D84E;' +
    'stroke-linejoin:round;stroke-miterlimit:2;}</style></defs>' +
    '<path class="st0" d="M0 0 H10 V10 H0 Z"/>'));
  assert(sv(s, 15) === '#62D84E', `15 = ${sv(s, 15)}`);
});

t('vec: unsupported CSS (media query, display, id, combinator) → null', async () => {
  const cases = [
    ['media query', '<style>@media print{.c{fill:red}}</style><rect class="c" width="10" height="10"/>'],
    ['display prop', '<style>.c{display:none;fill:red}</style><rect class="c" width="10" height="10"/>'],
    ['id selector', '<style>#x{fill:red}</style><rect id="x" width="10" height="10"/>'],
    ['descendant combinator', '<style>g .c{fill:red}</style><g><rect class="c" width="10" height="10"/></g>'],
    ['pseudo-class', '<style>.c:hover{fill:red}</style><rect class="c" width="10" height="10"/>'],
  ];
  for (const [label, inner] of cases) {
    assert((await svgToSliceClip(V(inner))) === null, `${label} must fall back to PNG`);
  }
});

t('vec: real-world logo (Google Cloud pattern) converts both paths', async () => {
  const { shapes } = unwrap(await svgToSliceClip(V(
    '<defs><style>.cls-1{fill:#ea4335;}.cls-2{fill:#4285f4;}</style></defs>' +
    '<path class="cls-1" d="M0 0 H10 V10 H0 Z"/>' +
    '<path class="cls-2" d="M12 0 H22 V10 H12 Z"/>', 'viewBox="0 0 24 12"')));
  assert(shapes.length === 2, `${shapes.length} shapes`);
  assert(sv(shapes[0], 15) === '#EA4335' && sv(shapes[1], 15) === '#4285F4', 'both class fills applied');
});

t('vec: fill-rule on the root <svg> is inherited (Serif/Affinity exports)', async () => {
  // Same-winding outer+inner: nonzero → solid, evenodd → hole. The root
  // declares evenodd, so the path must render WITH a hole (two rings), not be
  // normalized to the nonzero solid.
  const eo = await one(V('<path fill="#f00" d="M0 0 H100 V100 H0 Z M30 30 H70 V70 H30 Z"/>',
    'viewBox="0 0 100 100" style="fill-rule:evenodd"'));
  const eoMoves = opPairs(path12(eo).ops).filter(([op]) => op === 0).length;
  assert(eoMoves === 2, `evenodd root must keep the hole (2 rings), got ${eoMoves}`);
  // Without the root declaration the same path is nonzero → solid (one ring).
  const nz = await one(V('<path fill="#f00" d="M0 0 H100 V100 H0 Z M30 30 H70 V70 H30 Z"/>'));
  const nzMoves = opPairs(path12(nz).ops).filter(([op]) => op === 0).length;
  assert(nzMoves === 1, `nonzero default must fill solid (1 ring), got ${nzMoves}`);
});

t('vec: fill inherits from ancestor groups', async () => {
  const s = await one(V('<g fill="#0000ff"><rect x="0" y="0" width="10" height="10"/></g>'));
  assert(sv(s, 15) === '#0000FF', `15 = ${sv(s, 15)}`);
});

t('vec: named colors normalize to hex', async () => {
  const s = await one(V('<rect x="0" y="0" width="10" height="10" fill="red"/>'));
  assert(sv(s, 15) === '#FF0000', `15 = ${sv(s, 15)}`);
});

t('vec: rgb() colors normalize to hex', async () => {
  const s = await one(V('<rect x="0" y="0" width="10" height="10" fill="rgb(0, 128, 255)"/>'));
  assert(sv(s, 15) === '#0080FF', `15 = ${sv(s, 15)}`);
});

t('vec: default fill is black, default stroke is none', async () => {
  const s = await one(V('<rect x="0" y="0" width="10" height="10"/>'));
  assert(sv(s, 15) === '#000000' && sv(s, 14) === 1, 'default fill black');
  assert(sv(s, 18) === 0, 'no stroke attr → 18:0');
  assert(sv(s, 19) === undefined, 'stroke-off must drop key 19');
});

t('vec: fill and stroke together', async () => {
  const s = await one(V('<rect x="0" y="0" width="10" height="10" fill="#ff0000" stroke="#00ff00" stroke-width="3"/>'));
  assert(sv(s, 14) === 1 && sv(s, 15) === '#FF0000', 'fill on');
  assert(sv(s, 18) !== 0 && sv(s, 19) === '#00FF00' && near(sv(s, 22), 1143), 'stroke on, 3px = 1143');
});

// --- gradients ---

t('vec: linear gradient → keys 60/61/62/145', async () => {
  const s = await one(V('<defs><linearGradient id="g">' +
    '<stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/>' +
    '</linearGradient></defs><rect x="0" y="0" width="50" height="50" fill="url(#g)"/>'));
  assert(sv(s, 60) === 1, `60 = ${sv(s, 60)}`);
  const stops = sv(s, 61);
  assert(stops.length === 2 && stops[0][0] === '#FF0000' && near(stops[0][1], 0, 0.01) &&
    stops[1][0] === '#0000FF' && near(stops[1][1], 1, 0.01), `61 = ${JSON.stringify(stops)}`);
  assert(near(sv(s, 62), 0, 0.01), `62 = ${sv(s, 62)} (default horizontal = 0 rad)`);
  assert(sv(s, 145) === 1, '145 gradient marker');
});

t('vec: radial gradient → 60:2 + 73 + 145', async () => {
  const s = await one(V('<defs><radialGradient id="r">' +
    '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#000000"/>' +
    '</radialGradient></defs><circle cx="25" cy="25" r="20" fill="url(#r)"/>'));
  assert(sv(s, 60) === 2 && sv(s, 73) === 1 && sv(s, 145) === 1,
    `60/73/145 = ${sv(s, 60)}/${sv(s, 73)}/${sv(s, 145)}`);
});

t('vec: unsupported gradient forms → null', async () => {
  for (const [label, g] of [
    ['gradientTransform', '<linearGradient id="g" gradientTransform="rotate(30)">' +
      '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>'],
    ['userSpaceOnUse', '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">' +
      '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>'],
    ['off-center radial', '<radialGradient id="g" fx="0.2" fy="0.2">' +
      '<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>'],
  ]) {
    const svg = V(`<defs>${g}</defs><rect x="0" y="0" width="50" height="50" fill="url(#g)"/>`);
    assert((await svgToSliceClip(svg)) === null, `${label} must fall back to PNG`);
  }
});

// --- fill rule (Slides fills evenodd, winding-independent) ---

t('vec: evenodd donut → two subpaths in one stream', async () => {
  const s = await one(V('<path fill-rule="evenodd" fill="#f00" d="M0 0 H100 V100 H0 Z M30 30 V70 H70 V30 Z"/>'));
  const { ops } = path12(s);
  assert(String(ops) === '0,2,1,6,5,0,0,2,1,6,5,0', `ops ${ops}`);
});

t('vec: nonzero donut (opposite winding) converts — same result under evenodd', async () => {
  const s = await one(V('<path fill="#f00" d="M0 0 H100 V100 H0 Z M30 30 V70 H70 V30 Z"/>'));
  assert(String(path12(s).ops) === '0,2,1,6,5,0,0,2,1,6,5,0');
});

t('vec: nonzero union (same-winding overlap) is merged, not notched', async () => {
  // Two overlapping squares under nonzero = one L/plus-shaped solid. Clipper
  // unions them into an evenodd-safe outline (one ring, no interior hole).
  const s = await one(V('<path fill="#f00" d="M0 0 H60 V60 H0 Z M30 30 H90 V90 H30 Z"/>'));
  const moves = opPairs(path12(s).ops).filter(([op]) => op === 0).length;
  assert(moves === 1, `union must be one merged ring, got ${moves} (would notch)`);
});

t('vec: STROKED self-overlapping path → null (stroke-on-union differs)', async () => {
  const svg = V('<path fill="#f00" stroke="#000" d="M0 0 H60 V60 H0 Z M30 30 H90 V90 H30 Z"/>');
  assert((await svgToSliceClip(svg)) === null, 'stroked overlap must fall back to PNG');
});

t('vec: single self-intersecting subpath (keyhole/wound-twice) is normalized', async () => {
  // One subpath tracing the square twice: nonzero fills it, evenodd would
  // empty it (winding 2). The pairwise-overlap check (needs ≥2 subpaths)
  // missed this — the crack in the stance logo's 'e'. Area comparison catches
  // it and normalizes to the correct nonzero region (one solid square).
  const s = await one(V('<path fill="#f00" d="M0 0 H80 V80 H0 Z M0 0 H80 V80 H0 Z"/>'));
  const { ops } = path12(s);
  const moves = opPairs(ops).filter(([op]) => op === 0).length;
  assert(moves === 1, `double-wound square must normalize to one ring, got ${moves}`);
});

t('vec: keyhole counter (opposite-wound via slit) normalizes to outer + hole', async () => {
  // Single contour reaching a counter through a zero-width slit (how logo
  // letters draw the 'e'/'a' aperture). Under evenodd the slit would crack;
  // normalized it becomes a clean outer ring + hole.
  const s = await one(V('<path fill="#f00" d="M0 0 H100 V100 H0 V55 H30 V30 H70 V70 H30 V55 H0 Z"/>'));
  const { coords } = path12(s);
  const seen = new Set();
  let dup = 0;
  for (let i = 0; i < coords.length; i += 2) {
    const k = `${coords[i]},${coords[i + 1]}`;
    if (seen.has(k)) dup++;
    seen.add(k);
  }
  assert(dup === 0, `slit points must be resolved away, ${dup} coincident remain`);
});

t('vec: same-winding subpaths with only touching bboxes convert (no false reject)', async () => {
  // Two disjoint squares whose bounding boxes overlap in the corner region but
  // whose fills never touch — the bug that killed the IBM / JPMC logos.
  const s = await one(V('<path fill="#f00" d="M0 0 H40 V40 H0 Z M50 30 H90 V70 H50 Z"/>'));
  const moves = opPairs(path12(s).ops).filter(([op]) => op === 0).length;
  assert(moves === 2, `both subpaths must survive, got ${moves}`);
});

t('vec: many same-winding non-overlapping subpaths (logo wordmark) convert', async () => {
  // Five adjacent bars, touching bboxes, no real overlap — must not reject.
  let d = '';
  for (let i = 0; i < 5; i++) d += `M${i * 12} 0 H${i * 12 + 10} V50 H${i * 12} Z `;
  const s = await one(V(`<path fill="#1f70c1" d="${d.trim()}"/>`, 'viewBox="0 0 70 50"'));
  const moves = opPairs(path12(s).ops).filter(([op]) => op === 0).length;
  assert(moves === 5, `all 5 bars must survive, got ${moves}`);
});

// --- out of scope → null ---

t('vec: out-of-scope features → null', async () => {
  // <text> left this list in v2 — it converts via text-to-curves now.
  const cases = [
    ['image', '<image width="10" height="10" href="data:image/png;base64,iVBORw0KGgo="/>'],
    ['use', '<defs><rect id="r" width="5" height="5"/></defs><use href="#r"/>'],
    ['pattern fill', '<defs><pattern id="p" width="4" height="4"><rect width="2" height="2"/></pattern></defs>' +
      '<rect width="10" height="10" fill="url(#p)"/>'],
    ['mask', '<defs><mask id="m"><rect width="10" height="10" fill="#fff"/></mask></defs>' +
      '<rect width="10" height="10" fill="#f00" mask="url(#m)"/>'],
    ['clip-path', '<defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
      '<rect width="10" height="10" fill="#f00" clip-path="url(#c)"/>'],
    ['filter', '<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>' +
      '<rect width="10" height="10" fill="#f00" filter="url(#f)"/>'],
    ['foreignObject', '<foreignObject width="10" height="10"><div>x</div></foreignObject>'],
  ];
  for (const [label, inner] of cases) {
    assert((await svgToSliceClip(V(inner))) === null, `${label} must fall back to PNG`);
  }
});

// Fill alpha is native (style key 16, pinned 2026-07-23); stroke alpha has
// no known key yet, so anything that fades a painted stroke stays PNG.

t('vec: fill-opacity → key 16', async () => {
  const s = await one(V('<rect width="10" height="10" fill="#f00" fill-opacity="0.5"/>'));
  assert(sv(s, 15) === '#FF0000' && near(sv(s, 16), 0.5, 0.001), `15/16 = ${sv(s, 15)}/${sv(s, 16)}`);
});

t('vec: rgba fill → color + key 16', async () => {
  const s = await one(V('<rect width="10" height="10" fill="rgba(255,0,0,0.5)"/>'));
  assert(sv(s, 15) === '#FF0000' && near(sv(s, 16), 0.5, 0.01), `15/16 = ${sv(s, 15)}/${sv(s, 16)}`);
});

t('vec: element opacity on unstroked shape → key 16', async () => {
  const s = await one(V('<rect width="10" height="10" fill="#f00" opacity="0.5"/>'));
  assert(near(sv(s, 16), 0.5, 0.001), `16 = ${sv(s, 16)}`);
});

t('vec: group opacity multiplies with fill-opacity', async () => {
  const s = await one(V('<g opacity="0.5"><rect width="10" height="10" fill="#f00" fill-opacity="0.5"/></g>'));
  assert(near(sv(s, 16), 0.25, 0.001), `16 = ${sv(s, 16)}`);
});

t('vec: opaque fill leaves key 16 absent', async () => {
  const s = await one(V('<rect width="10" height="10" fill="#f00"/>'));
  assert(sv(s, 16) === undefined, `16 = ${sv(s, 16)}`);
});

t('vec: faded painted strokes still → null', async () => {
  const cases = [
    ['stroke-opacity', '<rect width="10" height="10" fill="#f00" stroke="#000" stroke-opacity="0.5"/>'],
    ['opacity with stroke', '<rect width="10" height="10" fill="#f00" stroke="#000" opacity="0.5"/>'],
    ['rgba stroke', '<rect width="10" height="10" fill="#f00" stroke="rgba(0,0,0,0.5)"/>'],
    ['translucent gradient fill', '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/>' +
      '<stop offset="1" stop-color="#000"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)" fill-opacity="0.5"/>'],
  ];
  for (const [label, inner] of cases) {
    assert((await svgToSliceClip(V(inner))) === null, `${label} must fall back to PNG`);
  }
});

t('vec: malformed or non-SVG input → null', async () => {
  assert((await svgToSliceClip('<svg><rect')) === null, 'malformed');
  assert((await svgToSliceClip('<div>nope</div>')) === null, 'non-svg root');
});

// --- multi-shape and payload plumbing ---

t('vec: two elements → two shapes, ids consistent across resolved/unresolved', async () => {
  const flavors = await svgToSliceClip(V('<rect x="0" y="0" width="10" height="10" fill="#f00"/>' +
    '<rect x="20" y="0" width="10" height="10" fill="#0f0"/>'));
  const { data, shapes } = unwrap(flavors);
  assert(shapes.length === 2, `${shapes.length} shapes`);
  assert(shapes[0].id !== shapes[1].id, 'ids must be distinct');
  assert(JSON.stringify(data.unresolved) === JSON.stringify(data.resolved),
    'unresolved must clone resolved');
});

t('vec: paste is wrapped in one group over the anchor + every shape', async () => {
  const { data, shapes, anchor, groups } = unwrap(await svgToSliceClip(
    V('<rect x="0" y="0" width="10" height="10" fill="#f00"/>' +
      '<rect x="20" y="0" width="10" height="10" fill="#0f0"/>' +
      '<circle cx="40" cy="5" r="4" fill="#00f"/>', 'viewBox="0 0 60 10"')));
  assert(groups.length === 1, `expected one group, got ${groups.length}`);
  assert(anchor, 'a connector anchor rect must be present');
  const g = groups[0];
  assert(JSON.stringify(g[2]) === JSON.stringify([anchor.id, ...shapes.map((s) => s.id)]),
    'group lists the anchor first, then every shape, in order');
  assert(JSON.stringify(g[3]) === '[1,0,0,1,0,0]' && g[4] === 'p', 'identity transform, parent p');
  assert(data.resolved[data.resolved.length - 1][0] === 2, 'group is the last command');
  shapes.forEach((s) => assert(s.parent === 'p', 'children keep parent p'));
});

t('vec: even a single shape is grouped with a connector anchor', async () => {
  const { shapes, anchor, groups } = unwrap(await svgToSliceClip(V('<rect width="10" height="10" fill="#f00"/>')));
  assert(shapes.length === 1 && anchor && groups.length === 1, 'lone shape gets anchor + group');
});

t('vec: anchor is a transparent type-6 rect covering the union bbox', async () => {
  // Two 10-unit squares at x=0 and x=20 → union spans x 0..30, y 0..10.
  const { shapes, anchor } = unwrap(await svgToSliceClip(
    V('<rect x="0" y="0" width="10" height="10" fill="#f00"/>' +
      '<rect x="20" y="0" width="10" height="10" fill="#0f0"/>', 'viewBox="0 0 30 10"')));
  assert(anchor.type === 6, `anchor must be preset rect type 6, got ${anchor.type}`);
  const sv2 = (a, k) => { const i = a.style.indexOf(k); return i >= 0 ? a.style[i + 1] : undefined; };
  assert(sv2(anchor, 14) === 0, 'anchor fill must be off (transparent)');
  assert(sv2(anchor, 18) === 0, 'anchor stroke must be off');
  // preset rect: page size = transform a/d × 120000; origin = tx,ty.
  const bounds = shapes.reduce((b, s) => {
    const w = s.style[s.style.indexOf(8) + 1];
    const h = s.style[s.style.indexOf(9) + 1];
    return [Math.min(b[0], s.xf[4]), Math.min(b[1], s.xf[5]),
      Math.max(b[2], s.xf[4] + w), Math.max(b[3], s.xf[5] + h)];
  }, [Infinity, Infinity, -Infinity, -Infinity]);
  assert(near(anchor.xf[4], bounds[0], 2) && near(anchor.xf[5], bounds[1], 2), 'anchor origin = bbox min');
  assert(near(anchor.xf[0] * 120000, bounds[2] - bounds[0], 3), 'anchor width covers bbox');
  assert(near(anchor.xf[3] * 120000, bounds[3] - bounds[1], 3), 'anchor height covers bbox');
});

t('vec: null conversions never emit an anchor', async () => {
  assert((await svgToSliceClip(V('<text x="0" y="0">hi</text>'))) !== null, 'text converts (curves)');
  assert((await svgToSliceClip(V('<image width="5" height="5" href="data:image/png;base64,x"/>'))) === null,
    'image still PNG-falls-back (no partial anchor)');
});

t('vec: envelope is the sanitized template, ids/guid fresh per call', async () => {
  const svg = V('<rect x="0" y="0" width="10" height="10" fill="#f00"/>');
  const a = await svgToSliceClip(svg);
  const b = await svgToSliceClip(svg);
  const wa = JSON.parse(a[VTYPE]);
  assert(typeof wa.dih === 'number' && wa.dct === 'punch', 'dih/dct');
  assert('ds' in wa && 'cses' in wa && 'sm' in wa, 'load-bearing envelope fields');
  assert(!('edrk' in wa) && !('edi' in wa), 'server keys must be stripped');
  assert(!('application/x-vnd.google-docs-internal-clip-id' in a), 'clip-id must be absent');
  assert(typeof a['text/html'] === 'string' && typeof a['text/plain'] === 'string', 'sibling flavors');
  assert(unwrap(a).shapes[0].id !== unwrap(b).shapes[0].id, 'shape ids must differ per call');
  const guid = (h) => (h.match(/docs-internal-guid-[0-9a-f-]+/) || [null])[0];
  assert(guid(a['text/html']) && guid(a['text/html']) !== guid(b['text/html']),
    'html guid must be fresh per call');
});
