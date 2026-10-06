import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pickKnownConfig, DEFAULT_CONFIG, COMMON_PROXY_PORTS, saveConfig } from '../src/config.js';

test('saveConfig shape: runtime-only keys never reach config.json', () => {
  const persisted = pickKnownConfig(DEFAULT_CONFIG, {
    ...DEFAULT_CONFIG,
    coversDir: 'E:\\Workspace\\anime\\data\\covers',
    someFutureField: 42,
    resolvedProxy: 'http://127.0.0.1:7892',
  });
  assert.equal('coversDir' in persisted, false);
  assert.equal('someFutureField' in persisted, false);
  assert.equal(persisted.resolvedProxy, 'http://127.0.0.1:7892', 'resolvedProxy is part of the schema');
  assert.equal(persisted.server.port, DEFAULT_CONFIG.server.port);
  assert.deepEqual(persisted.scan.dirs, DEFAULT_CONFIG.scan.dirs);
});

test('saveConfig shape: a CLI port override is not persisted', () => {
  const runtime = { ...DEFAULT_CONFIG, server: { ...DEFAULT_CONFIG.server, port: 5199 } };
  // main.js applies --port after saveConfig(), so anything it writes keeps 5178.
  assert.equal(pickKnownConfig(DEFAULT_CONFIG, DEFAULT_CONFIG).server.port, 5178);
  assert.equal(pickKnownConfig(DEFAULT_CONFIG, runtime).server.port, 5199);
});

test('default ignore list only skips directories that hold no video', () => {
  const ignored = DEFAULT_CONFIG.scan.ignoreDirNames.map((name) => name.toLowerCase());
  for (const keep of ['sps', 'bonus', 'extras', 'menu']) {
    assert.equal(ignored.includes(keep), false, `${keep} must be scanned and classified as 特别篇`);
  }
  for (const skip of ['cds', 'scans', 'fonts', 'subs']) {
    assert.ok(ignored.includes(skip), `${skip} should be skipped`);
  }
});

test('proxy defaults are sane', () => {
  assert.equal(DEFAULT_CONFIG.proxy, 'auto');
  assert.equal(DEFAULT_CONFIG.resolvedProxy, null);
  assert.ok(COMMON_PROXY_PORTS.includes(7890));
  assert.ok(DEFAULT_CONFIG.metadata.matchThreshold > DEFAULT_CONFIG.metadata.matchMargin);
});

test('saveConfig: a patch never resets stored settings it did not mention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-config-'));
  const configPath = path.join(dir, 'config.json');
  const previous = process.env.ANIME_LIBRARY_CONFIG;
  process.env.ANIME_LIBRARY_CONFIG = configPath;
  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        scan: { dirs: ['D:\\Anime'] },
        appearance: { background: 'background.jpg', blur: 6, brightness: 0.8 },
        proxy: '',
      })
    );

    // Moving a background slider must not wipe the scan folder or the proxy.
    saveConfig({ appearance: { background: 'background.jpg', blur: 12, brightness: 0.8 } });
    const afterAppearance = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(afterAppearance.appearance.blur, 12);
    assert.deepEqual(afterAppearance.scan.dirs, ['D:\\Anime']);
    assert.equal(afterAppearance.proxy, '');

    // ...and saving an unrelated setting must not wipe the wallpaper.
    saveConfig({ proxy: 'http://127.0.0.1:7890' });
    const afterProxy = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(afterProxy.appearance.background, 'background.jpg');
    assert.equal(afterProxy.appearance.blur, 12);
    assert.deepEqual(afterProxy.scan.dirs, ['D:\\Anime']);
  } finally {
    if (previous === undefined) delete process.env.ANIME_LIBRARY_CONFIG;
    else process.env.ANIME_LIBRARY_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
