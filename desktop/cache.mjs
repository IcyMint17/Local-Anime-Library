/**
 * The Chromium profile that sits next to the library is mostly cache.
 *
 * The one that actually grows without bound is the HTTP disk cache: every image
 * the UI loads is stored there as a JPEG, and the match dialog pulls the
 * *full-size* cover of every candidate Bangumi returns — twelve ~900 KB files
 * per search. A single afternoon of rematching added 380 MB to the author's
 * profile, while the covers the library really needs already live in
 * `library/covers/`.
 *
 * Everything listed here is derived state: losing it costs a re-download and
 * nothing else. The library database, its covers, the settings and the
 * background image are deliberately *not* in this list.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Directories inside the profile that hold nothing but caches. */
export const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
  'DIPS',
  'blob_storage',
  'Shared Dictionary',
];

/** GPU shader caches are warm state, not junk: keeping them avoids a
 * first-seconds shader compile when hardware acceleration is on. */
export const GPU_CACHE_DIRS = [
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
];

/** Cache files that live directly in the profile root. */
export const CACHE_FILES = [
  'DIPS-wal',
  'declarative_performance_observer.db',
  'declarative_performance_observer.db-journal',
];

const entryPaths = (userData) => [
  ...CACHE_DIRS.map((name) => path.join(userData, name)),
  ...CACHE_FILES.map((name) => path.join(userData, name)),
];

function sizeOf(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;

  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) total += sizeOf(child);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(child).size;
      } catch {
        /* a file the app currently holds open simply counts as zero */
      }
    }
  }
  return total;
}

/** Bytes the app is happy to throw away. */
export function cacheBytes(userData) {
  return entryPaths(userData).reduce((total, target) => total + sizeOf(target), 0);
}

/**
 * Deletes the cache entries from disk.
 *
 * @returns {{before:number, after:number, removed:string[], skipped:string[]}}
 */
export function clearProfileCachesSync(userData, { keepGpu = false, live = false } = {}) {
  const gpuNames = new Set(GPU_CACHE_DIRS);
  const deferred = [];
  const targets = entryPaths(userData).filter((target) => {
    const name = path.basename(target);
    // GPU/Code caches are memory-mapped by the running Chromium processes;
    // deleting them under a live app can take the GPU process down. They are
    // cleared on the next cold start instead.
    if (keepGpu && gpuNames.has(name)) {
      if (fs.existsSync(target)) deferred.push(name);
      return false;
    }
    if (live && (gpuNames.has(name) || name === 'Code Cache')) {
      if (fs.existsSync(target)) deferred.push(name);
      return false;
    }
    return true;
  });
  const before = targets.reduce((total, target) => total + sizeOf(target), 0);

  const removed = [];
  const skipped = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    try {
      // Deliberately *not* `force: true`: that makes Node swallow permission
      // and sharing violations too, which is exactly what has to be reported
      // as "skipped" instead of pretending the cache is gone.
      fs.rmSync(target, { recursive: true, maxRetries: 3, retryDelay: 100 });
      removed.push(path.basename(target));
    } catch (error) {
      skipped.push(path.basename(target));
      if (process.env.ANIME_CACHE_DEBUG === '1') console.warn(`  ! ${target}: ${error.code ?? error.message}`);
    }
  }

  const after = targets.reduce((total, target) => total + sizeOf(target), 0);
  return { before, after, removed, skipped, deferred };
}

/**
 * Same, but lets Electron drop the in-memory copies first.
 *
 * With the app running the HTTP cache and the GPU caches are held open by other
 * processes, so the on-disk delete is best effort for whatever is left.
 */
export async function clearProfileCaches(userData, { session = null } = {}) {
  if (session?.clearCache) {
    // Only the HTTP cache is safe to drop while the app is running. Clearing
    // code/shader caches through the session has caused renderer/GPU crashes on
    // some Windows drivers, so those are deferred to the next cold start.
    await Promise.resolve(session.clearCache()).catch(() => {});
  }
  return clearProfileCachesSync(userData, { live: true });
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
