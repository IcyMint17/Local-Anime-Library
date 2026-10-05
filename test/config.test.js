import test from 'node:test';
import assert from 'node:assert/strict';

import { pickKnownConfig, DEFAULT_CONFIG, COMMON_PROXY_PORTS } from '../src/config.js';

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
