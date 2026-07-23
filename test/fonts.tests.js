'use strict';

// Contract tests for text-to-curves (fonts.js + the <text> branch in
// vectorize.js). A tiny TestFace font is built in-harness with the vendored
// opentype lib, so glyph geometry is exact and controlled:
//   'A' → square contour (100..500, 0..600 font units), advance 600
//   'B' → two same-winding overlapping squares (trips the evenodd/union check)
// unitsPerEm 1000. At font-size 10 the A-square is 4×6 px starting 1px right
// of the pen. Uses NS/V/one/sv/path12/near/arrNear from vectorize.tests.js.

let __testFaceUri = null;
function testFaceUri() {
  if (__testFaceUri) return __testFaceUri;
  const sq = (p, x0, y0, x1, y1) => {
    p.moveTo(x0, y0);
    p.lineTo(x1, y0);
    p.lineTo(x1, y1);
    p.lineTo(x0, y1);
    p.close();
  };
  const rsq = (p, x0, y0, x1, y1) => { // reversed winding: a counter/hole
    p.moveTo(x0, y0);
    p.lineTo(x0, y1);
    p.lineTo(x1, y1);
    p.lineTo(x1, y0);
    p.close();
  };
  const aPath = new opentype.Path();
  sq(aPath, 100, 0, 500, 600);
  const bPath = new opentype.Path();
  sq(bPath, 0, 0, 400, 400);
  sq(bPath, 200, 200, 600, 600);
  // 'C': the join-notch regression — the second contour partially overlaps
  // and STARTS INSIDE the first (like 'x'/'t'/'g' stroke joins). Same
  // winding → must union, never be misread as a hole.
  const cPath = new opentype.Path();
  sq(cPath, 0, 0, 600, 600);
  sq(cPath, 100, -100, 500, 500); // font y-up: -100 extends below baseline
  // 'D': a real counter — opposite winding, fully inside → must stay a hole.
  const dPath = new opentype.Path();
  sq(dPath, 0, 0, 600, 600);
  rsq(dPath, 200, 200, 400, 400);
  // 'E': a keyhole counter — ONE contour that tunnels through a zero-width
  // slit to draw the counter reversed (how Roboto draws 'e'). Must split at
  // the retraced points into outer + hole; raw emission cracks under evenodd.
  const ePath = new opentype.Path();
  ePath.moveTo(0, 0);
  ePath.lineTo(600, 0);
  ePath.lineTo(600, 600);
  ePath.lineTo(0, 600);
  ePath.lineTo(0, 300);
  ePath.lineTo(200, 300); // tunnel in
  ePath.lineTo(200, 400); // counter wound OPPOSITE to the outer (real keyhole)
  ePath.lineTo(400, 400);
  ePath.lineTo(400, 200);
  ePath.lineTo(200, 200);
  ePath.lineTo(200, 300); // retrace: tunnel out
  ePath.lineTo(0, 300);
  ePath.close();
  const glyphs = [
    new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 500, path: new opentype.Path() }),
    new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: aPath }),
    new opentype.Glyph({ name: 'B', unicode: 66, advanceWidth: 700, path: bPath }),
    new opentype.Glyph({ name: 'C', unicode: 67, advanceWidth: 700, path: cPath }),
    new opentype.Glyph({ name: 'D', unicode: 68, advanceWidth: 700, path: dPath }),
    new opentype.Glyph({ name: 'E', unicode: 69, advanceWidth: 700, path: ePath }),
    // 'F': ink wider (0..500) than its advance (300) → consecutive F's overlap,
    // mimicking a connecting-script join. The whole-run union must merge them.
    new opentype.Glyph({ name: 'F', unicode: 70, advanceWidth: 300, path: (() => {
      const p = new opentype.Path();
      sq(p, 0, 0, 500, 600);
      return p;
    })() }),
  ];
  const font = new opentype.Font({
    familyName: 'TestFace',
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs,
  });
  const bytes = new Uint8Array(font.toArrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  __testFaceUri = 'data:font/ttf;base64,' + btoa(bin);
  return __testFaceUri;
}

function faceStyle() {
  return `<style>@font-face{font-family:'TestFace';src:url(${testFaceUri()}) format('truetype');}</style>`;
}

function textSvg(textEl) {
  return V(`${faceStyle()}${textEl}`);
}

function hasCorner(coords, x, y, eps = 2) {
  for (let i = 0; i < coords.length; i += 2) {
    if (Math.abs(coords[i] - x) <= eps && Math.abs(coords[i + 1] - y) <= eps) return true;
  }
  return false;
}

// --- conversion ---

t('text: embedded @font-face glyph → exact square outline', async () => {
  const s = await one(textSvg('<text x="5" y="20" font-family="TestFace" font-size="10" fill="#ff0000">A</text>'));
  assert(s.type === 138, `type ${s.type}`);
  // A-square: x 6..10px, y 14..20px → units 2286..3810 / 5334..7620
  assert(arrNear([s.xf[4], s.xf[5]], [PX + 2286, PY + 5334], 3), `origin ${s.xf[4]},${s.xf[5]}`);
  assert(near(sv(s, 8), 1524, 3) && near(sv(s, 9), 2286, 3), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
  const { ops, coords } = path12(s);
  assert(String(ops) === '0,2,1,6,5,0', `ops ${ops}`);
  for (const [cx, cy] of [[0, 0], [1524, 0], [1524, 2286], [0, 2286]]) {
    assert(hasCorner(coords, cx, cy), `missing corner ${cx},${cy} in ${coords}`);
  }
  assert(sv(s, 14) === 1 && sv(s, 15) === '#FF0000', 'text fill via normal paint keys');
});

t('text: text-anchor middle/end shift by advance width', async () => {
  const mid = await one(textSvg('<text x="50" y="20" text-anchor="middle" font-family="TestFace" font-size="10">A</text>'));
  assert(near(mid.xf[4], PX + 18288, 3), `middle tx ${mid.xf[4]}`); // (50-3+1)px
  const end = await one(textSvg('<text x="50" y="20" text-anchor="end" font-family="TestFace" font-size="10">A</text>'));
  assert(near(end.xf[4], PX + 17145, 3), `end tx ${end.xf[4]}`); // (50-6+1)px = 45px
});

t('text: two non-touching glyphs → two subpaths, advance-spaced', async () => {
  const s = await one(textSvg('<text x="5" y="20" font-family="TestFace" font-size="10">AA</text>'));
  const { ops } = path12(s);
  const moves = opPairs(ops).filter(([op]) => op === 0).length;
  assert(moves === 2, `disjoint glyphs must stay separate, got ${moves} (ops ${ops})`);
  assert(near(sv(s, 8), 3810, 3), `8 = ${sv(s, 8)} (6..16px wide)`); // second A at +6px advance
});

t('text: connecting-script overlap (advance < ink) unions across glyphs', async () => {
  // 'FF': second F's advance (3px) lands its ink inside the first → the run
  // must merge into ONE outline, no notch at the join.
  const s = await one(textSvg('<text x="0" y="20" font-family="TestFace" font-size="10">FF</text>'));
  const { ops } = path12(s);
  const moves = opPairs(ops).filter(([op]) => op === 0).length;
  assert(moves === 1, `overlapping glyphs must union, got ${moves} subpaths (ops ${ops})`);
  assert(near(sv(s, 8), 3048, 3), `8 = ${sv(s, 8)} (0..8px merged width)`); // 0..500 + 300..800 = 0..800u
});

t('text: stroke and inherited font props apply', async () => {
  const s = await one(textSvg('<g font-family="TestFace" font-size="10" stroke="#00ff00" stroke-width="1" fill="none">' +
    '<text x="5" y="20">A</text></g>'));
  assert(sv(s, 14) === 0, 'fill none');
  assert(sv(s, 19) === '#00FF00' && near(sv(s, 22), 381), 'stroke mapped');
});

t('text: unknown family falls back to bundled face', async () => {
  const flavors = await svgToSliceClip(V('<text x="5" y="40" font-family="NoSuchFont" font-size="20">Hi</text>'));
  const { shapes } = unwrap(flavors);
  assert(shapes.length === 1, `${shapes.length} shapes`);
  assert(String(path12(shapes[0]).ops).length > 0, 'glyph outlines emitted');
});

t('text: resolver override returning null → PNG fallback', async () => {
  const svg = V('<text x="5" y="40" font-family="NoSuchFont" font-size="20">Hi</text>');
  const out = await svgToSliceClip(svg, { resolveFont: async () => null });
  assert(out === null, 'must return null when no face resolves');
});

t('text: weight maps to nearest available face', async () => {
  const s = await one(textSvg('<text x="5" y="20" font-family="TestFace" font-size="10" font-weight="700">A</text>'));
  assert(String(path12(s).ops) === '0,2,1,6,5,0', 'bold request served by the only face');
});

t('text: partial-overlap contour starting inside a sibling unions, no notch', async () => {
  // Regression: the 'g'/'x'/'t' join artifact — containment-based grouping
  // misread these as holes and punched gashes at every stroke joint.
  const s = await one(textSvg('<text x="0" y="20" font-family="TestFace" font-size="10">C</text>'));
  const { ops } = path12(s);
  const moves = opPairs(ops).filter(([op]) => op === 0).length;
  assert(moves === 1, `expected one merged outline, got ${moves} subpaths (ops ${ops})`);
  // bbox: x 0..600u = 6px wide; y -100..600u → 7px tall
  assert(near(sv(s, 8), 2286, 3) && near(sv(s, 9), 2667, 3), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
});

t('text: keyhole counter splits into outer + hole (no evenodd crack)', async () => {
  const s = await one(textSvg('<text x="0" y="20" font-family="TestFace" font-size="10">E</text>'));
  const { ops, coords } = path12(s);
  const moves = opPairs(ops).filter(([op]) => op === 0).length;
  assert(moves === 2, `expected outer + hole subpaths, got ${moves} (ops ${ops})`);
  // the zero-width tunnel must be gone: no coordinate pair may repeat within a subpath
  const pairs = new Set();
  for (let i = 0; i < coords.length; i += 2) pairs.add(`${coords[i]},${coords[i + 1]}`);
  assert(pairs.size === coords.length / 2, 'tunnel points still retraced');
});

t('text: opposite-winding counter survives as a hole', async () => {
  const s = await one(textSvg('<text x="0" y="20" font-family="TestFace" font-size="10">D</text>'));
  const { ops } = path12(s);
  const moves = opPairs(ops).filter(([op]) => op === 0).length;
  assert(moves === 2, `expected outer + hole subpaths, got ${moves} (ops ${ops})`);
});

// --- rejection ---

t('text: overlapping same-winding glyph contours union into one outline', async () => {
  // TrueType letterforms overlap contours routinely (Roboto 'H' = stems +
  // crossbar); raw emission would notch under Slides' evenodd fill, so the
  // pipeline flattens + unions. The 'B' test glyph is two overlapping squares
  // → must come out as a single merged subpath, 6px square bbox.
  const s = await one(textSvg('<text x="5" y="20" font-family="TestFace" font-size="10">B</text>'));
  const { ops } = path12(s);
  const moves = opPairs(ops).filter(([op]) => op === 0).length;
  assert(moves === 1, `expected one merged subpath, got ${moves} (ops ${ops})`);
  assert(near(sv(s, 8), 2286, 3) && near(sv(s, 9), 2286, 3), `8/9 = ${sv(s, 8)}/${sv(s, 9)}`);
});

t('text: out-of-scope text features → null', async () => {
  const cases = [
    ['tspan', '<text x="5" y="20" font-family="TestFace" font-size="10"><tspan>A</tspan></text>'],
    ['dx', '<text x="5" y="20" dx="2" font-family="TestFace" font-size="10">A</text>'],
    ['dy', '<text x="5" y="20" dy="2" font-family="TestFace" font-size="10">A</text>'],
    ['rotate', '<text x="5" y="20" rotate="10" font-family="TestFace" font-size="10">A</text>'],
    ['textLength', '<text x="5" y="20" textLength="50" font-family="TestFace" font-size="10">A</text>'],
    ['letter-spacing', '<text x="5" y="20" letter-spacing="2" font-family="TestFace" font-size="10">A</text>'],
  ];
  for (const [label, el] of cases) {
    assert((await svgToSliceClip(textSvg(el))) === null, `${label} must fall back to PNG`);
  }
});

t('text: <style> beyond @font-face still rejects', async () => {
  const svg = V(`<style>@font-face{font-family:'TestFace';src:url(${testFaceUri()});} .x{fill:red}</style>` +
    '<text x="5" y="20" font-family="TestFace" font-size="10">A</text>');
  assert((await svgToSliceClip(svg)) === null, 'non-font-face CSS must fall back to PNG');
});

t('text: empty or whitespace-only text renders nothing → null overall when alone', async () => {
  assert((await svgToSliceClip(textSvg('<text x="5" y="20" font-family="TestFace" font-size="10">  </text>'))) === null,
    'nothing convertible');
});

// --- Google Fonts css parser (M3 pure function) ---

t('fonts: parseGoogleFontsCss extracts the TTF url', () => {
  const css = "@font-face {\n  font-family: 'Roboto';\n  font-style: normal;\n  font-weight: 400;\n" +
    "  src: url(https://fonts.gstatic.com/s/roboto/v51/KFOM.ttf) format('truetype');\n}\n";
  assert(parseGoogleFontsCss(css) === 'https://fonts.gstatic.com/s/roboto/v51/KFOM.ttf');
  assert(parseGoogleFontsCss('body { color: red }') === null, 'no url → null');
});
