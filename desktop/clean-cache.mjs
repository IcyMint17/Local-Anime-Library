#!/usr/bin/env node
/**
 * Removes the Chromium profile caches that live next to the library.
 *
 * Run it with the app closed:  node desktop/clean-cache.mjs
 *
 * The library itself (`library/`), the settings, the covers and the background
 * image are never touched — see cache.mjs for what counts as a cache.
 */
import os from 'node:os';
import path from 'node:path';
import { cacheBytes, clearProfileCaches, formatBytes, CACHE_DIRS, CACHE_FILES } from './cache.mjs';

const userData = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'AnimeLibrary');

if (!userData || userData === path.parse(userData).root) {
  console.error(`拒绝在 ${userData} 上运行。`);
  process.exit(1);
}

console.log(`配置目录: ${userData}`);
console.log(`清理前缓存: ${formatBytes(cacheBytes(userData))}`);

const result = await clearProfileCaches(userData);

console.log(`清理后缓存: ${formatBytes(result.after)}`);
console.log(`已释放: ${formatBytes(result.before - result.after)}`);
if (result.removed.length) console.log(`已删除: ${result.removed.join('、')}`);
if (result.skipped.length) {
  console.log(`被占用、跳过: ${result.skipped.join('、')}`);
  console.log('（请先退出「本地番剧媒体库」再运行一次）');
}
console.log(`\n这些目录是缓存，删掉后应用会自动重建：\n  ${[...CACHE_DIRS, ...CACHE_FILES].join('\n  ')}`);
