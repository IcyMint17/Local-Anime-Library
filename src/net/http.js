/**
 * Proxy-aware HTTP client.
 *
 * Node's built-in fetch does not use the system proxy, and on Windows a lot of
 * users reach the internet through a local Clash-style proxy. So we implement a
 * small HTTP/1.1 client that can talk either directly or through an HTTP proxy
 * via a CONNECT tunnel. Zero dependencies.
 */
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export class HttpError extends Error {
  constructor(message, { status = 0, body = '', url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens a TCP connection to the proxy and negotiates a CONNECT tunnel. */
export function openTunnel(proxyUrl, host, port, timeoutMs = 15000) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error(`连接代理超时: ${proxyUrl}`)));
    socket.once('error', (err) => fail(new Error(`无法连接代理 ${proxyUrl}: ${err.message}`)));
    socket.once('connect', () => {
      socket.setTimeout(timeoutMs, () => fail(new Error(`代理 CONNECT 超时: ${host}:${port}`)));
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        if (settled) return;
        settled = true;
        socket.off('data', onData);
        socket.setTimeout(0);
        const statusLine = buffer.split('\r\n')[0];
        const code = Number(/^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(statusLine)?.[1] ?? 0);
        if (code !== 200) {
          socket.destroy();
          reject(new Error(`代理拒绝 CONNECT (${statusLine})`));
          return;
        }
        resolve(socket);
      };
      socket.on('data', onData);
      const headers = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'Proxy-Connection: Keep-Alive'];
      if (proxy.username) {
        const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`;
        headers.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`);
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    });
  });
}

/** An https.Agent that hands out one already-connected socket, exactly once. */
class PreconnectedAgent extends https.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this._preconnected = socket;
  }

  createConnection(options, callback) {
    const socket = this._preconnected;
    this._preconnected = null;
    if (callback) callback(null, socket);
    return socket;
  }
}

async function connectThroughProxy(proxy, url, timeoutMs) {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const raw = await openTunnel(proxy, url.hostname, port, timeoutMs);
  if (url.protocol !== 'https:') return { socket: raw, secure: false };
  const secured = tls.connect({ socket: raw, servername: url.hostname, rejectUnauthorized: true });
  await new Promise((resolve, reject) => {
    secured.once('secureConnect', resolve);
    secured.once('error', (err) => reject(new Error(`TLS handshake failed: ${err.message}`)));
    secured.setTimeout(timeoutMs, () => {
      secured.destroy();
      reject(new Error('TLS handshake timeout'));
    });
  });
  secured.setTimeout(0);
  return { socket: secured, secure: true };
}

function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') return zlib.inflateSync(buffer);
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    return buffer;
  }
  return buffer;
}

/**
 * Performs one HTTP request.
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    proxy = null,
    timeoutMs = 30000,
  } = options;

  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port || (isHttps ? 443 : 80));
  const requestHeaders = {
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'close',
    ...headers,
  };
  if (body != null && requestHeaders['Content-Length'] == null) {
    requestHeaders['Content-Length'] = Buffer.byteLength(body);
  }

  const common = {
    method,
    path: `${target.pathname}${target.search}`,
    headers: requestHeaders,
    servername: isHttps ? target.hostname : undefined,
    host: target.hostname,
    port,
  };

  let agent;
  if (proxy) {
    const { socket } = await connectThroughProxy(proxy, target, timeoutMs);
    if (isHttps) agent = new PreconnectedAgent(socket);
    else agent = new http.Agent();
  }

  if (proxy && !isHttps) {
    // Plain HTTP through a proxy: tunnel is unnecessary, but we already have a
    // socket; write an absolute-form request over it.
    return rawHttpOverSocket(agent, target, requestHeaders, method, body, timeoutMs);
  }

  const transport = isHttps ? https : http;
  const requestOptions = agent ? { ...common, agent } : common;

  return new Promise((resolve, reject) => {
    const req = transport.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: decompress(Buffer.concat(chunks), res.headers['content-encoding']),
        });
      });
      res.on('error', reject);
      req.setTimeout(0);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 (${timeoutMs}ms): ${url}`));
    });
    req.on('error', (err) => reject(new Error(`${err.message} (${url})`)));
    if (body != null) req.write(body);
    req.end();
  });
}

/** Minimal absolute-form HTTP/1.1 request for http:// targets behind a proxy. */
function rawHttpOverSocket(socket, target, headers, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lines = [`${method} ${target.href} HTTP/1.1`, `Host: ${target.host}`];
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'host') continue;
      lines.push(`${key}: ${value}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (body != null) socket.write(body);

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const statusLine = head.split('\r\n')[0];
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(statusLine)?.[1] ?? 0);
      resolve({
        status,
        headers: {},
        body: decompress(rest, ''),
      });
      socket.destroy();
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`请求超时: ${target.href}`));
    });
  });
}

/** Serialises calls so we never exceed one request per `minIntervalMs` per client. */
export function createRateLimiter(minIntervalMs) {
  let tail = Promise.resolve();
  let lastAt = 0;
  return function schedule(fn) {
    const run = tail.then(async () => {
      const wait = Math.max(0, lastAt + minIntervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      return fn();
    });
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

function isRetryable(error) {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  return true;
}

/**
 * Request with automatic retries and exponential backoff.
 */
export async function requestWithRetry(url, options = {}) {
  const { retries = 4, retryDelayMs = 600, ...rest } = options;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await request(url, rest);
      if (response.status === 429) {
        const retryAfter = Number(response.headers['retry-after']);
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelayMs * 2 ** attempt;
        if (attempt < retries) {
          await sleep(Math.min(delay, 15000) + Math.random() * 300);
          continue;
        }
      }
      if (response.status >= 400) {
        throw new HttpError(`HTTP ${response.status} ${url}`, {
          status: response.status,
          body: response.body.toString('utf8').slice(0, 500),
          url,
        });
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryable(error)) throw error;
      // Local proxies drop connections now and then; a fresh tunnel plus jitter
      // recovers most of the time.
      await sleep(Math.min(retryDelayMs * 2 ** attempt, 6000) + Math.random() * 400);
    }
  }
  throw lastError;
}

/** Fetches JSON. */
export async function requestJson(url, options = {}) {
  const { json, body, headers = {}, ...rest } = options;
  const payload = json !== undefined ? JSON.stringify(json) : body;
  const mergedHeaders = json !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers;
  const response = await requestWithRetry(url, { ...rest, headers: mergedHeaders, body: payload ?? null });
  const text = response.body.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`返回内容不是合法 JSON: ${url}`, { status: response.status, body: text.slice(0, 300), url });
  }
}

/** Fetches raw bytes (used for cover images). */
export async function requestBuffer(url, options = {}) {
  const response = await requestWithRetry(url, options);
  return response.body;
}

/** Quick check: can we actually reach `host:port` through this proxy? */
export async function testProxy(proxyUrl, { host = 'api.bgm.tv', port = 443, timeoutMs = 6000 } = {}) {
  try {
    const socket = await openTunnel(proxyUrl, host, port, timeoutMs);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}
