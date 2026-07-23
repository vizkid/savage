'use strict';

// Shared test harness. Load order in test.html: sources under test, then this
// file, then the test files (they call t() at eval time); the runner fires on
// window load, writes PASS/FAIL to #results and a machine-readable summary to
// window.__testResults for dev-browser to read.

const cases = [];
function t(name, fn) {
  cases.push({ name, fn });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
async function expectReject(promise, pattern) {
  try {
    await promise;
  } catch (err) {
    assert(pattern.test(err.message), `rejected, but message "${err.message}" !~ ${pattern}`);
    return;
  }
  throw new Error('expected rejection, but resolved');
}
async function pixelsOf(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return { ctx, width: bmp.width, height: bmp.height };
}
function alphaAt(ctx, x, y) {
  return ctx.getImageData(x, y, 1, 1).data[3];
}

window.addEventListener('load', async () => {
  const results = document.getElementById('results');
  let pass = 0;
  let fail = 0;
  for (const { name, fn } of cases) {
    const li = document.createElement('li');
    try {
      await fn();
      li.className = 'pass';
      li.textContent = name;
      pass++;
    } catch (err) {
      li.className = 'fail';
      li.textContent = `${name}: ${err.message}`;
      fail++;
    }
    results.appendChild(li);
  }
  const summary = `${pass} passed, ${fail} failed, ${cases.length} total`;
  document.getElementById('summary').textContent = summary;
  document.title = fail ? `FAIL: ${summary}` : `PASS: ${summary}`;
  window.__testResults = { pass, fail, total: cases.length, done: true };
});
