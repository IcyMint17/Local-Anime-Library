/**
 * Recursive directory traversal for a media library.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isVideoFile } from './parse.js';

/**
 * Hands control back to the event loop.
 *
 * The scan used to run entirely synchronously, which froze the HTTP server for
 * the whole file walk — status requests could not be answered, so the UI never
 * saw "扫描中" and the POST itself blocked for seconds. Yielding every so often
 * keeps the server responsive while it works.
 */
const breathe = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Walks `root` and returns every video file found.
 *
 * @returns {Promise<{files:Array<object>, skippedFiles:number, errors:Array<{path:string,message:string}>}>}
 */
export async function walkVideos(root, options = {}) {
  const { ignoreDirNames = [], maxDepth = 12 } = options;
  const ignore = new Set(ignoreDirNames.map((name) => name.toLowerCase()));
  const files = [];
  const errors = [];
  let skippedFiles = 0;
  let visited = 0;

  const stack = [{ dir: root, depth: 0, segments: [] }];
  while (stack.length > 0) {
    const { dir, depth, segments } = stack.pop();
    visited += 1;
    if (visited % 25 === 0) await breathe();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: dir, message: error.message });
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (ignore.has(entry.name.toLowerCase())) continue;
        stack.push({ dir: full, depth: depth + 1, segments: [...segments, entry.name] });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isVideoFile(entry.name)) {
        skippedFiles += 1;
        continue;
      }

      let stats;
      try {
        stats = fs.statSync(full);
      } catch (error) {
        errors.push({ path: full, message: error.message });
        continue;
      }

      const dot = entry.name.lastIndexOf('.');
      files.push({
        path: full,
        name: entry.name,
        baseName: dot === -1 ? entry.name : entry.name.slice(0, dot),
        ext: dot === -1 ? '' : entry.name.slice(dot).toLowerCase(),
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        relSegments: [...segments, entry.name],
        relDirSegments: segments,
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
  return { files, skippedFiles, errors };
}

/** Counts directories that contain no video at all — reported but not imported. */
export async function findEmptySeriesFolders(root) {
  const empty = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return empty;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const result = await walkVideos(path.join(root, entry.name));
    if (result.files.length === 0) empty.push(entry.name);
  }
  return empty;
}
