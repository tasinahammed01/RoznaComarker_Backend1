'use strict';
const sharp = require('sharp');

// Generated document control, not a real student's work or a handwriting classifier fixture.
// Includes margins and pen-like strokes so exposure tests do not rely on solid colors.
async function pageImage({ width = 800, height = 1000, gain = 1, blur = 0, angle = 0, format = 'png', exif } = {}) {
  const lines = Array.from({ length: 18 }, (_, row) => Array.from({ length: 50 }, (_, col) => {
    const x = 70 + col * 12, y = 100 + row * 43;
    return '<path d="M' + x + ' ' + y + ' q3 -18 6 -8 t5 8 q-4 9 -8 0" fill="none" stroke="#333" stroke-width="1.5"/>';
  }).join('')).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="100%" height="100%" fill="#fcfaf5"/>${lines}<path d="M70 920 Q90 900 105 917 T150 915 T210 918" fill="none" stroke="#333" stroke-width="2"/></svg>`;
  let image = sharp(Buffer.from(svg)).resize(width, height).linear(gain).rotate(angle);
  if (blur) image = image.blur(blur);
  if (exif) image = image.withMetadata({ orientation: exif });
  return image.toFormat(format).toBuffer();
}
module.exports = { pageImage };
