/**
 * Builds desktop/icon.ico from the shared public/icon.jpg.
 *
 * Electron's nativeImage decodes JPEG in the main process, so no window or
 * rendering is involved. The .ico wraps a single 256x256 PNG, which is what
 * Windows expects for an application icon.
 */
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', 'public', 'icon.jpg');
const iconTarget = path.join(here, 'icon.ico');
const pngTarget = path.join(here, 'icon-256.png');
const SIZE = 256;

function buildIco(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // width 0 means 256
  entry.writeUInt8(0, 1); // height 0 means 256
  entry.writeUInt8(0, 2); // palette size
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, pngBuffer]);
}

app.whenReady().then(() => {
  try {
    if (!fs.existsSync(source)) throw new Error(`找不到源图: ${source}`);

    const original = nativeImage.createFromPath(source);
    if (original.isEmpty()) throw new Error('Electron 无法解码这张图片');
    const { width, height } = original.getSize();

    const square = nativeImage.createFromBuffer(original.toPNG());
    const resized = square.resize({
      width: SIZE,
      height: SIZE,
      quality: 'best',
    });
    const png = resized.toPNG();

    fs.writeFileSync(pngTarget, png);
    fs.writeFileSync(iconTarget, buildIco(png));
    console.log(`源图 ${width}x${height}`);
    console.log(`icon-256.png  ${png.length} bytes`);
    console.log(`icon.ico      ${fs.statSync(iconTarget).size} bytes`);
    app.exit(0);
  } catch (error) {
    console.error(`生成图标失败: ${error.message}`);
    app.exit(1);
  }
});
