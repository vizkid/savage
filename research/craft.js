'use strict';

// Generates replay payloads with hand-built geometry to pin down the path
// opcode semantics. Usage: node craft.js <experiment> <outfile>
// Output is dump-format JSON: copy its text, focus Slides, Cmd+Shift+9.

const fs = require('fs');

const TYPE = 'application/x-vnd.google-docs-drawings-object+wrapped';

let seq = 0;
function freshId() {
  return 'g' + Math.random().toString(16).slice(2, 13) + '_0_' + ++seq;
}

// One freeform shape command pair. ops/coords are the raw path streams.
// fill14: key 14 = fill on/off (0 = transparent, 1 = filled), pinned by the
// P3 probes 2026-07-23 — earlier experiments read it as path smoothing.
// type default is 138: type 154 (very likely) spline-smooths op-1 chains —
// the curve captures were 154/smooth, the polyline 138/straight, and the one
// synthetic 154 square ever rendered came out a smoothed blob (b-envelope).
// See FINDINGS "Shape type is the op-1 interpreter switch". Every sync-clean
// crafted shape to date has been 138.
function shape({ type = 138, tx, ty, ops, coords, w, h, fill14 = 0, extraStyle = [] }) {
  const id = freshId();
  const style = [
    12, [[1, 1, ops, coords, [], 0]],
    14, fill14,
    15, '#EEEEEE',
    19, '#595959',
    22, 381,
    27, 1.3,
    30, 1.3,
    8, w,
    9, h,
    ...extraStyle,
  ];
  return [
    [3, id, type, [1, 0, 0, 1, tx, ty], style, 'p'],
    [17, id, null, 0, 1, [], [12, 2]],
  ];
}

function payload(shapes) {
  const resolved = shapes.flat();
  const data = {
    resolved,
    unresolved: JSON.parse(JSON.stringify(resolved)),
    autotext_content: {},
    did_remove_empty_picture_placeholders: false,
    copy_source_supports_inheritance_via_master: true,
  };
  // Minimal envelope: no dih, no server keys, no clip-id, no html/text flavors.
  return { [TYPE]: JSON.stringify({ data: JSON.stringify(data), dct: 'punch' }) };
}

// Experiment A: candidate opcodes for lineTo / cubicTo.
// Every shape: start at (0,0), then ONE candidate op consuming 6 coords:
//   (100000,0, 100000,100000, 0,100000)
// If the op is a 3-point line chain: an open square missing its left side.
// If the op is one cubic bezier (2 controls + end): a smooth arc from
// top-left to bottom-left bulging right, no corners.
// If the op is invalid: shape missing (or whole paste fails; the control
// shape distinguishes).
const CANDIDATES = [1, 2, 3, 4, 6, 7];

function experimentA() {
  const shapes = [];
  // Control: known-good op 1 chain, no fill. Renders the open square.
  // Placed first, leftmost. If even this is missing, the skeleton is the problem,
  // not the candidate ops.
  let x = 20000;
  shapes.push(shape({
    tx: x, ty: 30000, w: 100000, h: 100000, fill14: 0,
    ops: [0, 2, 1, 6],
    coords: [0, 0, 100000, 0, 100000, 100000, 0, 100000],
  }));
  for (const op of CANDIDATES.slice(1)) {
    x += 130000;
    shapes.push(shape({
      tx: x, ty: 30000, w: 100000, h: 100000, fill14: 0,
      ops: [0, 2, op, 6],
      coords: [0, 0, 100000, 0, 100000, 100000, 0, 100000],
    }));
  }
  return payload(shapes);
}

// Experiment B: ladder from a known-good real dump down to the synthetic
// skeleton, to find which layer the deserializer rejects.
// b-sanity  : real dump, ids+guid randomized, clip-id and server keys
//             stripped. Mirrors the manual flow that provably rendered.
// b-envelope: single synthetic control shape (op 1), but envelope fields
//             (dih/ds/cses/sm) copied from the real dump and the text/plain
//             + text/html flavors kept.
// b-minimal : same control shape, bare {data, dct} envelope, single flavor
//             (same skeleton experiment A used).
const CLIPID = 'application/x-vnd.google-docs-internal-clip-id';

function randomizeIds(dump) {
  const wrapper = JSON.parse(dump[TYPE]);
  const data = JSON.parse(wrapper.data);
  const ids = new Set();
  for (const list of [data.resolved, data.unresolved]) {
    for (const cmd of list || []) if (typeof cmd[1] === 'string') ids.add(cmd[1]);
  }
  let s = JSON.stringify(data);
  for (const id of ids) s = s.split(id).join(freshId());
  wrapper.data = s;
  dump[TYPE] = JSON.stringify(wrapper);
  if (typeof dump['text/html'] === 'string') {
    dump['text/html'] = dump['text/html'].replace(/docs-internal-guid-[0-9a-f-]+/g,
      () => 'docs-internal-guid-' + Math.random().toString(16).slice(2, 10) + '-ffff-aaaa-bbbb-cccccccccccc');
  }
  return dump;
}

function controlShape() {
  return shape({
    tx: 20000, ty: 30000, w: 100000, h: 100000, fill14: 0,
    ops: [0, 2, 1, 6],
    coords: [0, 0, 100000, 0, 100000, 100000, 0, 100000],
  });
}

function experimentB(dumpFile, variant) {
  const src = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
  if (variant === 'sanity') {
    const dump = randomizeIds({ ...src });
    delete dump[CLIPID];
    const wrapper = JSON.parse(dump[TYPE]);
    delete wrapper.edrk;
    delete wrapper.edi;
    dump[TYPE] = JSON.stringify(wrapper);
    return dump;
  }
  const p = payload([controlShape()]);
  if (variant === 'minimal') return p;
  return wearEnvelope(p, src);
}

// Graft the real dump's envelope fields + sibling flavors around a synthetic
// payload. A bare {data, dct} envelope silently drops; this is the proven fix.
function wearEnvelope(p, src) {
  const realWrapper = JSON.parse(src[TYPE]);
  const myWrapper = JSON.parse(p[TYPE]);
  p[TYPE] = JSON.stringify({
    dih: realWrapper.dih,
    data: myWrapper.data,
    dct: 'punch',
    ds: realWrapper.ds,
    cses: realWrapper.cses,
    sm: realWrapper.sm,
  });
  p['text/plain'] = ' ';
  p['text/html'] = (src['text/html'] || '').replace(/docs-internal-guid-[0-9a-f-]+/g,
    () => 'docs-internal-guid-' + Math.random().toString(16).slice(2, 10) + '-ffff-aaaa-bbbb-cccccccccccc');
  return p;
}

// Experiment C: start from the working sanity payload (real data, real
// envelope, ids/guid randomized, lookup keys stripped) and change ONE thing:
// c-type    : shape type 138 -> 154 only
// c-path    : path streams swapped for the synthetic open square (op 1) only
// c-unres   : c-path + unresolved replaced by a clone of resolved
// c-op<N>   : c-path but with candidate opcode N instead of 1
function experimentC(dumpFile, variant) {
  const src = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
  const dump = randomizeIds({ ...src });
  delete dump[CLIPID];
  const wrapper = JSON.parse(dump[TYPE]);
  delete wrapper.edrk;
  delete wrapper.edi;
  const data = JSON.parse(wrapper.data);

  const opMatch = variant.match(/^op(\d+)$/);
  for (const list of [data.resolved, data.unresolved]) {
    for (const cmd of list) {
      if (cmd[0] !== 3) continue;
      if (variant === 'type') cmd[2] = 154;
      if (variant === 'path' || variant === 'unres' || opMatch) {
        const op = opMatch ? Number(opMatch[1]) : 1;
        const style = cmd[4];
        const i12 = style.indexOf(12);
        style[i12 + 1] = [[1, 1, [0, 2, op, 6], [0, 0, 100000, 0, 100000, 100000, 0, 100000], [], 0]];
        const i8 = style.indexOf(8);
        const i9 = style.indexOf(9);
        if (i8 >= 0) style[i8 + 1] = 100000;
        if (i9 >= 0) style[i9 + 1] = 100000;
      }
    }
  }
  if (variant === 'unres') data.unresolved = JSON.parse(JSON.stringify(data.resolved));
  wrapper.data = JSON.stringify(data);
  dump[TYPE] = JSON.stringify(wrapper);
  return dump;
}

// Experiment D: does one op-3 run chain multiple cubics (2n coords) or take
// exactly one (6 coords)? Three shapes, left to right:
//   1. control square (op 1) — proves the payload skeleton works
//   2. S-wave, one cubic per op-3 run
//   3. the same S-wave as a single 12-coord op-3 run
// Read: 3 identical to 2 + doc syncs → chaining works. 3 missing/garbled or
// the doc 400s → emit one cubic per op.
const SWAVE = [0, 50000, 16000, 0, 33000, 0, 50000, 50000, 66000, 100000, 83000, 100000, 100000, 50000];

function experimentD(src) {
  const box = { ty: 30000, w: 100000, h: 100000, fill14: 1 };
  return wearEnvelope(payload([
    shape({ ...box, tx: 20000, ops: [0, 2, 1, 6], coords: [0, 0, 100000, 0, 100000, 100000, 0, 100000] }),
    shape({ ...box, tx: 150000, ops: [0, 2, 3, 6, 3, 6], coords: SWAVE }),
    shape({ ...box, tx: 280000, ops: [0, 2, 3, 12], coords: SWAVE }),
  ]), src);
}

// Experiment E: multi-subpath + fill rule. Three shapes, left to right:
//   1. donut, inner square wound opposite the outer (nonzero rule → hole)
//   2. donut, inner square wound the same way (hole only under evenodd)
//   3. two disjoint squares in one path (basic multi-M support)
// Read: 1 holed + 2 solid → nonzero. 1 and 2 both holed → evenodd.
// Nothing renders / 400 → multi-subpath out of scope, PNG fallback.
function experimentE(src) {
  const box = { ty: 30000, w: 100000, h: 100000, fill14: 1 };
  const outer = [0, 0, 100000, 0, 100000, 100000, 0, 100000];
  const donutOps = [0, 2, 1, 6, 5, 0, 0, 2, 1, 6, 5, 0];
  return wearEnvelope(payload([
    shape({ ...box, tx: 20000, ops: donutOps,
      coords: [...outer, 30000, 30000, 30000, 70000, 70000, 70000, 70000, 30000] }),
    shape({ ...box, tx: 150000, ops: donutOps,
      coords: [...outer, 30000, 30000, 70000, 30000, 70000, 70000, 30000, 70000] }),
    shape({ ...box, tx: 280000, ops: donutOps,
      coords: [0, 0, 40000, 0, 40000, 40000, 0, 40000, 60000, 60000, 100000, 60000, 100000, 100000, 60000, 100000] }),
  ]), src);
}

// Experiment M: probes ported onto the PROVEN morph recipe (real dump, ids
// randomized, lookup keys stripped, geometry swapped in place — the
// converter's design, validated by L2 2026-07-23):
// m-multi     : shape pair (cmd 3 + cmd 17) duplicated with a fresh id, the
//               copy offset right — gates multi-shape SVGs
// m-chain     : path → one op-3 run, 12 coords (two cubics chained)
// m-cubic2    : path → two op-3 runs, 6 coords each (control for m-chain)
// m-donut     : two subpaths, inner wound opposite the outer (nonzero → hole)
// m-donut-same: inner wound the same way (hole only under evenodd)
const SQUARE = { ops: [0, 2, 1, 6, 5, 0], coords: [0, 0, 100000, 0, 100000, 100000, 0, 100000] };
const DONUT_OPS = [0, 2, 1, 6, 5, 0, 0, 2, 1, 6, 5, 0];
const OUTER = [0, 0, 100000, 0, 100000, 100000, 0, 100000];

function experimentM(dumpFile, variant) {
  const paths = {
    multi: SQUARE,
    chain: { ops: [0, 2, 3, 12], coords: SWAVE },
    cubic2: { ops: [0, 2, 3, 6, 3, 6], coords: SWAVE },
    donut: { ops: DONUT_OPS, coords: [...OUTER, 30000, 30000, 30000, 70000, 70000, 70000, 70000, 30000] },
    'donut-same': { ops: DONUT_OPS, coords: [...OUTER, 30000, 30000, 70000, 30000, 70000, 70000, 30000, 70000] },
  };
  const p = paths[variant];
  if (!p) { console.error(`unknown m variant: ${variant}`); process.exit(1); }

  const src = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
  const dump = randomizeIds({ ...src });
  delete dump[CLIPID];
  const wrapper = JSON.parse(dump[TYPE]);
  delete wrapper.edrk;
  delete wrapper.edi;
  const data = JSON.parse(wrapper.data);
  const cloneId = freshId(); // one id, used in BOTH lists like real payloads
  for (const list of [data.resolved, data.unresolved]) {
    const shapeCmd = list.find((c) => c[0] === 3);
    // 154 (the freeform template's type) spline-smooths op-1 chains — L2
    // rendered the square with curved sides. 138 draws them straight.
    shapeCmd[2] = 138;
    const style = shapeCmd[4];
    style[style.indexOf(12) + 1] = [[1, 1, p.ops, p.coords, [], 0]];
    style[style.indexOf(8) + 1] = 100000;
    style[style.indexOf(9) + 1] = 100000;
    if (variant === 'multi') {
      const shapeClone = JSON.parse(JSON.stringify(shapeCmd));
      shapeClone[1] = cloneId;
      shapeClone[3][4] += 70000; // keep the proven transform, just shift tx
      list.push(shapeClone);
      // The freeform dump carries no cmd-17 tail (rect dumps do) — optional.
      const tail = list.find((c) => c[0] === 17 && c[1] === shapeCmd[1]);
      if (tail) {
        const tailClone = JSON.parse(JSON.stringify(tail));
        tailClone[1] = cloneId;
        list.push(tailClone);
      }
    }
  }
  wrapper.data = JSON.stringify(data);
  dump[TYPE] = JSON.stringify(wrapper);
  return dump;
}

// Experiment F: THE gating test — does a single, fully-synthetic shape sync
// (no 400), not just render? Every sync-clean result so far mutated real dump
// data; the converter builds from scratch. One closed, filled square, proven
// opcodes only (0 move, 1 line-chain, 5 close). Renders + survives reload →
// synthesis is viable, build proceeds. 400s → converter must mutate a template
// shape instead. Uses the real envelope graft (proven load-bearing).
function experimentF(src) {
  return wearEnvelope(payload([
    shape({
      tx: 90000, ty: 40000, w: 100000, h: 100000, fill14: 1,
      ops: [0, 2, 1, 6, 5, 0],
      coords: [0, 0, 100000, 0, 100000, 100000, 0, 100000],
    }),
  ]), src);
}

const [, , name, outfile, dumpFile] = process.argv;
let result;
if (name === 'a') result = experimentA();
else if (name === 'b-sanity' || name === 'b-envelope' || name === 'b-minimal') {
  if (!dumpFile) { console.error('experiment b needs a real dump file as 3rd arg'); process.exit(1); }
  result = experimentB(dumpFile, name.slice(2));
} else if (name.startsWith('c-')) {
  if (!dumpFile) { console.error('experiment c needs a real dump file as 3rd arg'); process.exit(1); }
  result = experimentC(dumpFile, name.slice(2));
} else if (name.startsWith('m-')) {
  if (!dumpFile) { console.error(`experiment ${name} needs a real dump file as 3rd arg`); process.exit(1); }
  result = experimentM(dumpFile, name.slice(2));
} else if (name === 'd-chain' || name === 'e-donut' || name === 'f-solo') {
  if (!dumpFile) { console.error(`experiment ${name} needs a real dump file as 3rd arg`); process.exit(1); }
  const src = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
  result = name === 'd-chain' ? experimentD(src)
    : name === 'e-donut' ? experimentE(src)
    : experimentF(src);
} else {
  console.error('usage: node craft.js <a|b-sanity|b-envelope|b-minimal|c-*|d-chain|e-donut|f-solo> <outfile> [realDump.json]');
  process.exit(1);
}
fs.writeFileSync(outfile, JSON.stringify(result, null, 2));
console.log('wrote', outfile);
