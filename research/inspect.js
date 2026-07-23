'use strict';

// Pretty-prints a clipboard dump: envelope fields, then each command in
// data.resolved with style keys decoded. Usage: node inspect.js <dump.json>

const fs = require('fs');

const TYPE = 'application/x-vnd.google-docs-drawings-object+wrapped';

const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log('flavors:', Object.keys(dump).join(', '));
if (!dump[TYPE]) process.exit(0);

const wrapper = JSON.parse(dump[TYPE]);
const { data, ...envelope } = wrapper;
console.log('envelope:', JSON.stringify(envelope));

const parsed = JSON.parse(data);
console.log('data keys:', Object.keys(parsed).join(', '));

function describeStyle(style) {
  const out = [];
  for (let i = 0; i < style.length; i += 2) {
    const key = style[i];
    let val = style[i + 1];
    if (key === 12 && Array.isArray(val)) {
      val = val.map(([, , ops, coords]) =>
        `ops=[${ops}] coords(${coords.length})=[${coords.join(',')}]`).join(' | ');
    } else {
      val = JSON.stringify(val);
    }
    out.push(`  ${String(key).padStart(4)}: ${val}`);
  }
  return out.join('\n');
}

for (const list of ['resolved', 'unresolved']) {
  console.log(`\n--- ${list} (${(parsed[list] || []).length} commands) ---`);
  for (const cmd of parsed[list] || []) {
    const [op, id, ...rest] = cmd;
    if (op === 3) {
      const [shapeType, xf, style, parent] = rest;
      console.log(`cmd 3 (shape) id=${id} type=${shapeType} parent=${parent}`);
      console.log(`  transform: [${xf.join(', ')}]`);
      console.log(describeStyle(style));
    } else {
      console.log(`cmd ${op}: ${JSON.stringify(cmd)}`);
    }
  }
}
