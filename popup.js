'use strict';

const input = document.getElementById('px');
const allSites = document.getElementById('allsites');
const ALL_SITES = { origins: ['<all_urls>'] };

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

chrome.permissions.contains(ALL_SITES).then((granted) => {
  allSites.checked = granted;
});

allSites.addEventListener('change', async () => {
  if (allSites.checked) {
    allSites.checked = await chrome.permissions.request(ALL_SITES);
  } else {
    await chrome.permissions.remove(ALL_SITES);
  }
});
