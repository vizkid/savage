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
function shape({ type = 154, tx, ty, ops, coords, w, h, smooth = 0, extraStyle = [] }) {
  const id = freshId();
  const style = [
    12, [[1, 1, ops, coords, [], 0]],
    14, smooth,
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
  // Control: known-good op 1 chain, straight (smooth=0). Renders the open square.
  // Placed first, leftmost. If even this is missing, the skeleton is the problem,
  // not the candidate ops.
  let x = 20000;
  shapes.push(shape({
    tx: x, ty: 30000, w: 100000, h: 100000, smooth: 0,
    ops: [0, 2, 1, 6],
    coords: [0, 0, 100000, 0, 100000, 100000, 0, 100000],
  }));
  for (const op of CANDIDATES.slice(1)) {
    x += 130000;
    shapes.push(shape({
      tx: x, ty: 30000, w: 100000, h: 100000, smooth: 0,
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
    tx: 20000, ty: 30000, w: 100000, h: 100000, smooth: 0,
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
  // envelope: graft real envelope fields + sibling flavors around synthetic data
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

const [, , name, outfile, dumpFile] = process.argv;
let result;
if (name === 'a') result = experimentA();
else if (name === 'b-sanity' || name === 'b-envelope' || name === 'b-minimal') {
  if (!dumpFile) { console.error('experiment b needs a real dump file as 3rd arg'); process.exit(1); }
  result = experimentB(dumpFile, name.slice(2));
} else if (name.startsWith('c-')) {
  if (!dumpFile) { console.error('experiment c needs a real dump file as 3rd arg'); process.exit(1); }
  result = experimentC(dumpFile, name.slice(2));
} else {
  console.error('usage: node craft.js <a|b-sanity|b-envelope|b-minimal> <outfile> [realDump.json]');
  process.exit(1);
}
fs.writeFileSync(outfile, JSON.stringify(result, null, 2));
console.log('wrote', outfile);
