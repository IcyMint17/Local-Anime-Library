/**
 * Builds desktop/staging — a clean copy of just what the desktop app needs.
 *
 * electron-packager packs one directory, and the app spans two (the Electron
 * shell lives here, the server and UI live one level up), so the layout is
 * assembled explicitly instead of shipping the whole repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const staging = path.join(here, 'staging');

const COPY_DIRS = ['src', 'public'];
const COPY_FILES = ['config.json', 'README.md'];
const SHELL_FILES = ['main.mjs', 'icon.ico', 'package.json'];

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

for (const dir of COPY_DIRS) {
  const from = path.join(projectRoot, dir);
  if (!fs.existsSync(from)) throw new Error(`缺少目录: ${from}`);
  fs.cpSync(from, path.join(staging, dir), { recursive: true });
}

for (const file of COPY_FILES) {
  const from = path.join(projectRoot, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(staging, file));
}

for (const file of SHELL_FILES) {
  const from = path.join(here, file);
  if (!fs.existsSync(from)) throw new Error(`缺少文件: ${from}（先运行 npm run make-icon）`);
  fs.copyFileSync(from, path.join(staging, file));
}

// The staged package.json must not list devDependencies — everything it needs
// already lives outside the app bundle (Electron itself is added by packager).
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
delete manifest.devDependencies;
delete manifest.scripts;
delete manifest.private;
fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const walk = (dir, base = '') => {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += walk(path.join(dir, entry.name), `${base}${entry.name}/`);
    else count += 1;
  }
  return count;
};

console.log(`staging 就绪: ${staging}`);
console.log(`文件数: ${walk(staging)}`);
