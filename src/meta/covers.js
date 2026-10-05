/**
 * Cover image caching. Posters are downloaded once and served from disk, so the
 * library stays usable offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { requestBuffer } from '../net/http.js';

function extensionFor(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
  } catch {
    return '.jpg';
  }
}

/**
 * @returns {Promise<string|null>} Absolute path of the cached cover, or null.
 */
export async function ensureCover({ subject, coversDir, proxy, userAgent }) {
  const url =
    subject.cover_url ??
    subject.images?.large ??
    subject.images?.common ??
    subject.images?.medium ??
    subject.images?.grid ??
    null;
  if (!url) return null;

  const file = path.join(coversDir, `${subject.id ?? subject.bangumi_id}${extensionFor(url)}`);
  try {
    if (fs.statSync(file).size > 0) return file;
  } catch {
    // not cached yet
  }

  try {
    const buffer = await requestBuffer(url, {
      proxy,
      headers: { 'User-Agent': userAgent, Referer: 'https://bgm.tv/' },
      timeoutMs: 30000,
      retries: 2,
    });
    fs.mkdirSync(coversDir, { recursive: true });
    fs.writeFileSync(file, buffer);
    return file;
  } catch {
    return null;
  }
}
