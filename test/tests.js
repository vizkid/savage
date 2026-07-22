'use strict';

// Unit tests for rasterize.js + config.js. No framework: t() registers a case,
// the runner writes PASS/FAIL to #results and a machine-readable summary to
// window.__testResults for dev-browser to read.

const NS = 'xmlns="http://www.w3.org/2000/svg"';

const FIX = {
  viewBoxOnly:
    `<svg ${NS} viewBox="0 0 100 50"><rect x="40" y="15" width="20" height="20" fill="red"/></svg>`,
  wide: `<svg ${NS} viewBox="0 0 400 100"><rect width="400" height="100" fill="blue"/></svg>`,
  noDims: `<svg ${NS}><circle cx="256" cy="256" r="100" fill="green"/></svg>`,
  attrsOnly: `<svg ${NS} width="300" height="150"><rect width="300" height="150" fill="purple"/></svg>`,
  malformed: `<svg ${NS}><rect`,
  externalHref: `<svg ${NS} viewBox="0 0 10 10"><image href="https://example.com/x.png"/></svg>`,
  externalXlink:
    `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">` +
    `<image xlink:href="http://example.com/x.png"/></svg>`,
  externalCss:
    `<svg ${NS} viewBox="0 0 10 10"><rect width="10" height="10" style="fill:url(https://example.com/p.svg#a)"/></svg>`,
  dataHref:
    `<svg ${NS} viewBox="0 0 10 10"><image width="10" height="10" href="data:image/png;base64,` +
    `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="/></svg>`,
  fragmentUse:
    `<svg ${NS} viewBox="0 0 10 10"><defs><rect id="r" width="5" height="5" fill="red"/></defs><use href="#r"/></svg>`,
};

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

// --- sizing ---

t('viewBox only (100×50) → 2048×1024, PNG matches', async () => {
  const { blob, width, height } = await rasterizeSvg(FIX.viewBoxOnly, 2048);
  assert(width === 2048 && height === 1024, `reported ${width}×${height}`);
  const bmp = await createImageBitmap(blob);
  assert(bmp.width === 2048 && bmp.height === 1024, `png is ${bmp.width}×${bmp.height}`);
});

t('wide 4:1 → 2048×512, not distorted', async () => {
  const { width, height } = await rasterizeSvg(FIX.wide, 2048);
  assert(width === 2048 && height === 512, `reported ${width}×${height}`);
});

t('no dims at all → 512 default square → 2048×2048', async () => {
  const { width, height } = await rasterizeSvg(FIX.noDims, 2048);
  assert(width === 2048 && height === 2048, `reported ${width}×${height}`);
});

t('width/height attrs, no viewBox → viewBox synthesized, content scales', async () => {
  const { blob, width, height } = await rasterizeSvg(FIX.attrsOnly, 2048);
  assert(width === 2048 && height === 1024, `reported ${width}×${height}`);
  // The 300×150 purple rect fills the whole canvas only if a viewBox was synthesized.
  const { ctx } = await pixelsOf(blob);
  assert(alphaAt(ctx, 2000, 1000) === 255, 'far corner content missing, viewBox not synthesized');
});

t('custom outputPx 1024 → 1024 longest side', async () => {
  const { width, height } = await rasterizeSvg(FIX.viewBoxOnly, 1024);
  assert(width === 1024 && height === 512, `reported ${width}×${height}`);
});

// --- rejection ---

t('malformed SVG rejects (parse error)', async () => {
  await expectReject(rasterizeSvg(FIX.malformed, 2048), /parse/i);
});

t('external <image href> rejects via pre-scan', async () => {
  await expectReject(rasterizeSvg(FIX.externalHref, 2048), /external/i);
});

t('external xlink:href rejects via pre-scan', async () => {
  await expectReject(rasterizeSvg(FIX.externalXlink, 2048), /external/i);
});

t('external url() in style rejects via pre-scan', async () => {
  await expectReject(rasterizeSvg(FIX.externalCss, 2048), /external/i);
});

t('data: href passes the pre-scan', async () => {
  const { width } = await rasterizeSvg(FIX.dataHref, 2048);
  assert(width === 2048, `got width ${width}`);
});

t('#fragment use href passes the pre-scan', async () => {
  const { width } = await rasterizeSvg(FIX.fragmentUse, 2048);
  assert(width === 2048, `got width ${width}`);
});

// --- transparency ---

t('background is transparent, content is opaque', async () => {
  const { blob } = await rasterizeSvg(FIX.viewBoxOnly, 256);
  const { ctx, width, height } = await pixelsOf(blob);
  assert(alphaAt(ctx, 1, 1) === 0, 'corner not transparent');
  assert(alphaAt(ctx, 3, height - 3) === 0, 'corner not transparent');
  assert(alphaAt(ctx, Math.floor(width / 2), Math.floor(height / 2)) === 255, 'center content missing');
});

// --- detection (strict prefix rule) ---

t('detect: bare <svg… accepted', () => {
  assert(extractSvgFromText(FIX.viewBoxOnly) !== null);
});

t('detect: whitespace + prolog + doctype + comments before <svg accepted', () => {
  const txt =
    '\n\t <?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
    '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!-- exported --><!-- twice -->\n' +
    FIX.viewBoxOnly;
  assert(extractSvgFromText(txt) !== null);
});

t('detect: <svg mid-prose rejected', () => {
  assert(extractSvgFromText('check this out: <svg xmlns="…"></svg>') === null);
});

t('detect: SVG inside copied HTML rejected', () => {
  assert(extractSvgFromText('<div class="icon"><svg viewBox="0 0 1 1"></svg></div>') === null);
});

t('detect: UTF-8 BOM before prolog accepted', () => {
  assert(extractSvgFromText('﻿<?xml version="1.0"?>' + FIX.viewBoxOnly) !== null);
});

t('detect: plain text rejected', () => {
  assert(extractSvgFromText('hello world') === null);
});

t('detect: <svga… (prefix of longer tag name) rejected', () => {
  assert(extractSvgFromText('<svgadata foo="1"/>') === null);
});

// --- config ---

t('DEFAULT_OUTPUT_PX is 2048; getOutputPx falls back to it outside the extension', async () => {
  assert(DEFAULT_OUTPUT_PX === 2048, `DEFAULT_OUTPUT_PX=${typeof DEFAULT_OUTPUT_PX}`);
  assert((await getOutputPx()) === 2048, 'getOutputPx did not fall back to default');
});

// --- runner ---

(async () => {
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
})();
