import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cacheBytes, clearProfileCaches, clearProfileCachesSync, CACHE_DIRS } from '../desktop/cache.mjs';

/** A profile shaped like the real one: caches next to the library. */
function fakeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-profile-'));
  const write = (rel, bytes) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  };
  write('Cache/Cache_Data/f_000001', 4096);
  write('GPUCache/data_0', 1024);
  write('DawnGraphiteCache/data_0', 512);
  write('DIPS-wal', 128);
  write('library/library.db', 2048);
  write('library/config.json', 64);
  write('library/covers/514353.jpg', 1024);
  write('library/background.jpg', 2048);
  write('startup.log', 32);
  write('Local Storage/leveldb/CURRENT', 16);
  return dir;
}

test('cache: only cache entries are measured', () => {
  const dir = fakeProfile();
  assert.equal(cacheBytes(dir), 4096 + 1024 + 512 + 128);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: the cache list can never contain the library or the preferences', () => {
  for (const forbidden of ['library', 'Local Storage', 'Session Storage', 'Preferences', 'Local State', 'Network']) {
    assert.equal(CACHE_DIRS.includes(forbidden), false, `${forbidden} is not a cache`);
  }
});

test('cache: clearing keeps the library, the covers and the background', () => {
  const dir = fakeProfile();
  const result = clearProfileCachesSync(dir);

  assert.equal(result.before, 4096 + 1024 + 512 + 128);
  assert.equal(result.after, 0);
  assert.deepEqual(result.skipped, []);

  for (const keep of [
    'library/library.db',
    'library/config.json',
    'library/covers/514353.jpg',
    'library/background.jpg',
    'startup.log',
    'Local Storage/leveldb/CURRENT',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, keep)), `${keep} must survive a cache clean`);
  }
  for (const gone of ['Cache', 'GPUCache', 'DawnGraphiteCache', 'DIPS-wal']) {
    assert.equal(fs.existsSync(path.join(dir, gone)), false, `${gone} should be removed`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: the running-app path drops the in-memory copies first', async () => {
  const dir = fakeProfile();
  const calls = [];
  const session = {
    clearCache: async () => calls.push('http'),
    clearCodeCaches: async () => calls.push('code'),
    clearStorageData: async ({ storages }) => calls.push(`storage:${storages.join(',')}`),
  };

  const result = await clearProfileCaches(dir, { session });

  assert.deepEqual(calls, ['http', 'code', 'storage:shadercache,cachestorage']);
  assert.equal(result.after, 0);
  assert.ok(fs.existsSync(path.join(dir, 'library', 'library.db')));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('cache: an Electron session without the optional APIs is still fine', async () => {
  const dir = fakeProfile();
  const result = await clearProfileCaches(dir, { session: {} });
  assert.equal(result.after, 0);
  assert.ok(fs.existsSync(path.join(dir, 'library', 'library.db')));
  fs.rmSync(dir, { recursive: true, force: true });
});
