# Vendored third-party files

| File | What | Version/source | License |
|---|---|---|---|
| `opentype.min.js` | Font parser (glyph outlines for text-to-curves) | opentype.js 1.3.4, unpkg dist build | MIT © opentype.js authors |
| `roboto-regular.js` | Roboto Regular static TTF, base64-embedded | fonts.gstatic.com `s/roboto/v51` (fetched 2026-07-23) | Apache License 2.0 © The Roboto Project Authors |
| `martinez.umd.js` | Polygon boolean ops (glyph contour unions — TrueType glyphs overlap same-winding contours, which would notch under Slides' evenodd fill) | martinez-polygon-clipping 0.7.4, unpkg dist | MIT © Alex Milevski |

Roboto is the bundled fallback face for text-to-curves (`VECTOR2-SPEC.md`):
used only when an SVG names a font that is neither embedded in the SVG nor
fetchable from Google Fonts. Regenerate `roboto-regular.js` by base64-encoding
a fresh static TTF into the `ROBOTO_REGULAR_TTF_BASE64` constant.
