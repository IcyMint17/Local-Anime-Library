/**
 * Tiny static file + JSON API server. No framework, no build step.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { matchRoute } from './api/routes.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendFile(res, filePath) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Cache-Control': filePath.includes(`${path.sep}covers${path.sep}`) ? 'public, max-age=604800' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

/** Resolves a URL path inside `root`, refusing anything that escapes it. */
function resolveInside(root, relative) {
  const target = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
  const normalisedRoot = path.resolve(root);
  if (target !== normalisedRoot && !target.startsWith(normalisedRoot + path.sep)) return null;
  return target;
}

export function createServer({ routes, publicDir, coversDir, logger = console }) {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname.startsWith('/api/')) {
      const matched = matchRoute(routes, req.method, pathname);
      if (!matched) return sendJson(res, 404, { error: `未知接口 ${req.method} ${pathname}` });
      try {
        let body = {};
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) body = await readBody(req);
        const result = await matched.route.handler(matched.params, body, requestUrl.searchParams, req);
        if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
          return sendJson(res, result.status, result.body);
        }
        return sendJson(res, 200, result ?? { ok: true });
      } catch (error) {
        logger.error?.(`${req.method} ${pathname} 失败:`, error.message);
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (pathname.startsWith('/covers/')) {
      const file = resolveInside(coversDir, pathname.slice('/covers/'.length));
      if (file && sendFile(res, file)) return undefined;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('封面不存在');
    }

    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = resolveInside(publicDir, relative);
    if (file && sendFile(res, file)) return undefined;

    // Single-page app: unknown paths fall back to index.html.
    const fallback = path.join(publicDir, 'index.html');
    if (sendFile(res, fallback)) return undefined;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('未找到');
  });
}
