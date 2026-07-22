'use strict';

// Pure SVG logic: detection + rasterization. No extension APIs, no page
// state — loaded by both the content script and the unit test page.

// Strict prefix rule: after leading whitespace, XML prolog, doctype, and
// comments, the text must begin with an <svg> root tag. Never scan mid-string
// — copied HTML or prose that merely contains an SVG must not trigger.
function extractSvgFromText(text) {
  if (typeof text !== 'string') return null;
  let s = text;
  for (;;) {
    const before = s;
    s = s
      .replace(/^[\s﻿]+/, '')
      .replace(/^<\?xml[\s\S]*?\?>/i, '')
      .replace(/^<!DOCTYPE[^>]*>/i, '')
      .replace(/^<!--[\s\S]*?-->/, '');
    if (s === before) break;
  }
  return /^<svg[\s/>]/i.test(s) ? text : null;
}

// SVG loaded via <img> renders in SVG-as-image mode: external resources are
// silently omitted (the canvas never taints), so a blank-area PNG is the
// failure mode unless we reject up front.
function hasExternalRefs(doc) {
  const externalUrl = /url\(\s*(?!['"]?\s*(#|data:))/i;
  for (const el of doc.querySelectorAll('*')) {
    if (el.localName !== 'a') {
      const href =
        el.getAttribute('href') ||
        el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (href) {
        const v = href.trim();
        if (v && !v.startsWith('#') && !/^data:/i.test(v)) return true;
      }
    }
    const style = el.getAttribute('style');
    if (style && externalUrl.test(style)) return true;
    if (el.localName === 'style' && externalUrl.test(el.textContent || '')) return true;
  }
  return false;
}

function attrPx(el, name) {
  const v = el.getAttribute(name);
  if (!v || v.includes('%')) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// width/height attrs, else viewBox, else 512×512 default.
function resolveSize(svgEl) {
  const w = attrPx(svgEl, 'width');
  const h = attrPx(svgEl, 'height');
  if (w && h) return { width: w, height: h };
  const vb = (svgEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
  return { width: 512, height: 512 };
}

// SVG text → transparent PNG, longest side = outputPx, aspect preserved.
async function rasterizeSvg(svgText, outputPx) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (
    doc.querySelector('parsererror') ||
    doc.documentElement.localName !== 'svg'
  ) {
    throw new Error('SVG parse error');
  }
  if (hasExternalRefs(doc)) throw new Error('SVG uses external images');

  const svg = doc.documentElement;
  const size = resolveSize(svg);
  const scale = outputPx / Math.max(size.width, size.height);
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);

  if (!svg.getAttribute('viewBox')) {
    svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  }
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);

  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' })
  );
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG could not be rendered'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png')
    );
    return { blob, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
