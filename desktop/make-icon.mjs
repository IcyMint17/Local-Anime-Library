/**
 * Builds desktop/icon.ico and icon-256.png from the rounded-square master
 * `icon-source-rounded.png` (derived from public/icon.jpg with transparent
 * corners).
 *
 * Electron's nativeImage decodes PNG in the main process, so no window or
 * rendering is involved. The .ico carries 16–256 px entries so Explorer, the
 * taskbar and the installer all get a sharp icon.
 */
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'icon-source-rounded.png');
const iconTarget = path.join(here, 'icon.ico');
const pngTarget = path.join(here, 'icon-256.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = header.length + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.png.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

app.whenReady().then(() => {
  try {
    if (!fs.existsSync(source)) throw new Error(`找不到圆角源图: ${source}`);

    const original = nativeImage.createFromPath(source);
    if (original.isEmpty()) throw new Error('Electron 无法解码这张图片');

    const images = SIZES.map((size) => ({
      size,
      png: nativeImage
        .createFromBuffer(original.toPNG())
        .resize({ width: size, height: size, quality: 'best' })
        .toPNG(),
    }));
    const png = images.find((image) => image.size === 256).png;

    fs.writeFileSync(pngTarget, png);
    fs.writeFileSync(iconTarget, buildIco(images));
    console.log(`源图 ${original.getSize().width}x${original.getSize().height}`);
    console.log(`icon-256.png  ${png.length} bytes`);
    console.log(`icon.ico      ${fs.statSync(iconTarget).size} bytes (${SIZES.length} sizes)`);
    app.exit(0);
  } catch (error) {
    console.error(`生成图标失败: ${error.message}`);
    app.exit(1);
  }
});
