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
const SHELL_FILES = ['main.mjs', 'cache.mjs', 'icon.ico', 'package.json'];

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

/**
 * Every relative import in the staged JavaScript has to resolve inside the
 * bundle. Shipping main.mjs without the module it imports produced an app that
 * died with ERR_MODULE_NOT_FOUND before it could write a single log line, so
 * this is checked at build time rather than discovered by a user.
 */
function findBrokenImports(dir) {
  const broken = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      broken.push(...findBrokenImports(full));
      continue;
    }
    if (!/\.m?js$/.test(entry.name)) continue;
    const source = fs.readFileSync(full, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(full), match[1]);
      if (!fs.existsSync(target)) broken.push(`${path.relative(staging, full)} → ${match[1]}`);
    }
  }
  return broken;
}

const brokenImports = findBrokenImports(staging);
if (brokenImports.length > 0) {
  throw new Error(`staging 里有解析不了的相对导入:\n  ${brokenImports.join('\n  ')}`);
}

console.log(`staging 就绪: ${staging}`);
console.log(`文件数: ${walk(staging)}`);
