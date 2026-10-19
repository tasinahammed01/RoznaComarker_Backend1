'use strict';
const fs = require('fs');
const path = require('path');
const sizeOf = require('image-size');

/** Read-only provenance. An unset coordinate space is not proof of EXIF axes. */
async function annotationImageGeometry(page, loadFile) {
  if (!page?.fileId || !(page.width > 0 && page.height > 0)) return undefined;
  const base = { version: 1, fileId: String(page.fileId), pageNumber: Number(page.pageNumber || 1),
    width: page.ocrImageWidth || page.width, height: page.ocrImageHeight || page.height,
    orientation: page.ocrExifOrientation || 1, coordinateSpace: page.coordinateSpace || 'encoded-image',
    ambiguous: !page.coordinateSpace };
  if (page.coordinateSpace === 'display-image') return { ...base, ambiguous: false };
  if (page.derivedImageFileId && page.rasterizationVersion) return { ...base, coordinateSpace: 'display-image', orientation: 1, ambiguous: false };
  try {
    const file = await loadFile(String(page.fileId));
    if (!file?.path && !Buffer.isBuffer(file?.buffer)) return { ...base, ambiguous: true };
    const root = path.resolve(__dirname, '../..');
    const absolute = file.path ? path.resolve(root, file.path) : null;
    if (absolute && !absolute.startsWith(root + path.sep)) return { ...base, ambiguous: true };
    const metadata = sizeOf(Buffer.isBuffer(file.buffer) ? file.buffer : await fs.promises.readFile(absolute));
    const orientation = metadata.orientation || 1;
    const result = { ...base, orientation };
    if (!['jpg', 'png', 'webp'].includes(metadata.type) || ![1, 3, 6, 8].includes(orientation)) return { ...result, ambiguous: true };
    const encoded = metadata.width === page.width && metadata.height === page.height;
    const displayed = [6, 8].includes(orientation) && metadata.width !== metadata.height
      && metadata.height === page.width && metadata.width === page.height;
    if (page.coordinateSpace === 'encoded-image') return { ...result, ambiguous: !encoded };
    if (displayed) return { ...result, coordinateSpace: 'display-image', ambiguous: false };
    return { ...result, ambiguous: !encoded || orientation === 3
      || ([6, 8].includes(orientation) && metadata.width === metadata.height) };
  } catch { return { ...base, ambiguous: true }; }
}
module.exports = { annotationImageGeometry };
