'use strict';
// Source-fixture generation only; no application records or uploads are read.
const fs = require('fs/promises'); const path = require('path'); const sharp = require('sharp');
async function main() {
  const target = path.resolve(__dirname, '../../RoznaComarker/src/testing/fixtures/overlay-incident-image-fixtures.ts');
  if (!process.argv.includes('--apply')) return console.log(JSON.stringify({ dryRun: true, fixtures: 12, target: 'src/testing/fixtures/overlay-incident-image-fixtures.ts' }));
  const fixtures = [];
  for (const [width, height] of [[800, 600], [600, 800], [700, 680]]) for (const orientation of [1, 3, 6, 8]) {
    const visible = await sharp({ create: { width, height, channels: 3, background: '#fff' } })
      .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><rect x="${width * .1}" y="${height * .2}" width="${width * .15}" height="${height * .05}" fill="#00c800"/></svg>`) }]).png().toBuffer();
    const inverse = ({ 1: 0, 3: 180, 6: 270, 8: 90 })[orientation];
    const bytes = await sharp(visible).rotate(inverse).jpeg({ quality: 95 }).withMetadata({ orientation }).toBuffer();
    fixtures.push({ name: `${width}x${height}-exif-${orientation}`, width, height, orientation,
      url: `data:image/jpeg;base64,${bytes.toString('base64')}` });
  }
  await fs.writeFile(target, '// Synthetic green control word at x=10%, y=20%, w=15%, h=5%. Generated with sharp.\nexport const OVERLAY_INCIDENT_IMAGE_FIXTURES = ' + JSON.stringify(fixtures, null, 2) + ' as const;\n');
  console.log(JSON.stringify({ applied: true, fixtures: fixtures.length }));
}
if (require.main === module) main().catch(() => { console.error('Synthetic fixture generation failed.'); process.exitCode = 1; });
