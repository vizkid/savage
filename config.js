'use strict';

const DEFAULT_OUTPUT_PX = 2048;
const OUTPUT_PX_MIN = 256;
const OUTPUT_PX_MAX = 8192;

// Stored setting, falling back to the default when unset, out of range, or
// when chrome.storage isn't available (unit test page).
async function getOutputPx() {
  try {
    const { outputPx } = await chrome.storage.sync.get('outputPx');
    const px = Number(outputPx);
    if (Number.isFinite(px) && px >= OUTPUT_PX_MIN && px <= OUTPUT_PX_MAX) {
      return Math.round(px);
    }
  } catch (_) {}
  return DEFAULT_OUTPUT_PX;
}
