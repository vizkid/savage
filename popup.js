'use strict';

const input = document.getElementById('px');

chrome.storage.sync.get('outputPx').then(({ outputPx }) => {
  if (outputPx) input.value = outputPx;
});

input.addEventListener('input', () => {
  if (!input.value) {
    chrome.storage.sync.remove('outputPx');
    return;
  }
  const px = Number(input.value);
  if (Number.isFinite(px) && px >= OUTPUT_PX_MIN && px <= OUTPUT_PX_MAX) {
    chrome.storage.sync.set({ outputPx: Math.round(px) });
  }
});
