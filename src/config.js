/**
 * Configuration loading, saving and network-proxy discovery.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testProxy } from './net/http.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(SRC_DIR, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const COVERS_DIR = path.join(DATA_DIR, 'covers');
export const DB_PATH = path.join(DATA_DIR, 'library.db');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * Where the app keeps its files *right now*.
 *
 * The desktop build ships the code read-only inside the app bundle, so the
 * database and covers have to live in the user's profile instead. The Electron
 * entry point sets these environment variables before starting the server:
 *   ANIME_LIBRARY_ROOT — where `public/` and `config.json` live
 *   ANIME_LIBRARY_DATA — where `library.db` and `covers/` live
 */
export function dataPaths() {
  const root = process.env.ANIME_LIBRARY_ROOT ? path.resolve(process.env.ANIME_LIBRARY_ROOT) : ROOT;
  const dir = process.env.ANIME_LIBRARY_DATA ? path.resolve(process.env.ANIME_LIBRARY_DATA) : path.join(root, 'data');
  return {
    root,
    dataDir: dir,
    coversDir: path.join(dir, 'covers'),
    dbPath: path.join(dir, 'library.db'),
    // The desktop build ships the code inside a read-only archive, so its
    // settings have to live next to the database.
    configPath: process.env.ANIME_LIBRARY_CONFIG
      ? path.resolve(process.env.ANIME_LIBRARY_CONFIG)
      : path.join(root, 'config.json'),
    publicDir: path.join(root, 'public'),
  };
}

/** Local proxy ports commonly used by Clash / V2Ray / Surge style clients. */
export const COMMON_PROXY_PORTS = [7892, 7890, 7891, 10809, 10808, 2080, 1080, 8888, 8080, 20171];

export const DEFAULT_CONFIG = {
  server: {
    port: 5178,
    host: '127.0.0.1',
    openBrowser: true,
  },
  scan: {
    dirs: ['E:\\Videos\\Anime'],
    videoExtensions: ['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.webm', '.rmvb', '.iso'],
    // Only directories that never hold watchable video. Extras / SPs / Bonus
    // folders are deliberately *not* skipped — they are imported and classified
    // as 特别篇, so nothing the user owns disappears silently.
    ignoreDirNames: ['CDs', 'Scans', 'fonts', 'Fonts', 'subs', 'Subs'],
  },
  metadata: {
    provider: 'bangumi',
    userAgent: 'anime-library/0.1 (local media manager)',
    accessToken: '',
    requestIntervalMs: 1100,
    matchThreshold: 0.7,
    matchMargin: 0.06,
  },
  // 'auto' = detect, '' = never use a proxy, otherwise an explicit http://host:port
  proxy: 'auto',
  resolvedProxy: null,
  appearance: {
    // File name inside the data directory, or null when no background is set.
    background: null,
    blur: 0,
    brightness: 1,
  },
  // Look-and-feel choices. These live in the config file rather than only in
  // localStorage because the desktop shell picks a fresh port on every launch,
  // which makes it a fresh browser origin with an empty localStorage.
  ui: {
    theme: null,
    mode: 'dark',
    // Floating dock edge: 'left' | 'bottom' | 'right'.
    dock: 'bottom',
    // Backdrop blur in px for every glass panel (the liquid-glass slider).
    glass: 26,
    sidebarCollapsed: false,
  },
};

function deepMerge(base, override) {
  if (override == null) return structuredClone(base);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      output[key] = deepMerge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function ensureDirs() {
  const paths = dataPaths();
  for (const dir of [paths.dataDir, paths.coversDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig() {
  const { configPath } = dataPaths();
  let stored = {};
  if (fs.existsSync(configPath)) {
    try {
      stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      console.warn(`配置文件解析失败，使用默认配置: ${error.message}`);
      stored = {};
    }
  }
  return deepMerge(DEFAULT_CONFIG, stored);
}

export function saveConfig(config) {
  const { configPath } = dataPaths();
  // Merge the argument *over the stored file*, not over the defaults: callers
  // pass a patch ({"appearance": …}, {"proxy": …}), and merging onto the
  // defaults silently reset every setting the patch did not mention — which is
  // how changing the proxy used to wipe a wallpaper.
  const serialisable = pickKnownConfig(DEFAULT_CONFIG, deepMerge(loadConfig(), config));
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(serialisable, null, 2)}\n`, 'utf8');
  } catch (error) {
    // A read-only install location must not take the whole app down.
    console.warn(`配置写入失败（${configPath}）: ${error.message}`);
  }
  return serialisable;
}

/** Drops runtime-only fields (e.g. coversDir) so they never land in the file. */
export function pickKnownConfig(schema, value) {
  const output = {};
  for (const [key, fallback] of Object.entries(schema)) {
    if (!(key in value)) continue;
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      output[key] = pickKnownConfig(fallback, value[key] ?? {});
    } else {
      output[key] = value[key];
    }
  }
  return output;
}

export function updateConfig(patch) {
  const next = deepMerge(loadConfig(), patch);
  return saveConfig(next);
}

/** Reads the Windows "Internet Settings" proxy, when enabled. */
function readWindowsRegistryProxy() {
  if (process.platform !== 'win32') return [];
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const read = (name) => {
    try {
      return execFileSync('reg', ['query', key, '/v', name], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  };

  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(read('ProxyEnable'));
  const serverRaw = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(read('ProxyServer'))?.[1]?.trim();
  if (!enabled || !serverRaw) return [];

  // Forms: "127.0.0.1:7892" or "http=host:port;https=host:port"
  const candidates = [];
  if (serverRaw.includes('=')) {
    for (const part of serverRaw.split(';')) {
      const [scheme, value] = part.split('=');
      if (!value) continue;
      const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
      if (scheme.toLowerCase().startsWith('https')) candidates.unshift(withScheme);
      else candidates.push(withScheme);
    }
  } else {
    candidates.push(`http://${serverRaw}`);
  }
  return candidates;
}

function tcpReachable(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Works out which proxy (if any) actually lets us reach the metadata provider.
 * Candidates are tried in order and the first one that completes a CONNECT
 * tunnel to Bangumi wins.
 */
export async function detectProxy({ verbose = false } = {}) {
  const candidates = [];
  const push = (value, source) => {
    if (!value) return;
    const normalised = /^https?:\/\//i.test(value) ? value : `http://${value}`;
    if (!candidates.some((item) => item.url === normalised)) candidates.push({ url: normalised, source });
  };

  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    push(process.env[key], `环境变量 ${key}`);
  }
  for (const value of readWindowsRegistryProxy()) push(value, 'Windows 系统代理');
  for (const port of COMMON_PROXY_PORTS) push(`http://127.0.0.1:${port}`, `本地端口探测 ${port}`);

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = new URL(candidate.url);
    } catch {
      continue;
    }
    if (['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      const alive = await tcpReachable(parsed.hostname, Number(parsed.port) || 80);
      if (!alive) continue;
    }
    const ok = await testProxy(candidate.url);
    if (verbose) console.log(`  代理候选 ${candidate.url} (${candidate.source}) → ${ok ? '可用' : '不可用'}`);
    if (ok) return { proxy: candidate.url, source: candidate.source };
  }
  return { proxy: null, source: '直连' };
}

/**
 * Resolves the effective proxy for outbound metadata requests.
 * Cached in config.json so startup stays fast.
 */
export async function resolveProxy(config, { force = false, verbose = false } = {}) {
  if (config.proxy === '') return { proxy: null, source: '配置为直连' };
  if (config.proxy && config.proxy !== 'auto') {
    const ok = await testProxy(config.proxy);
    if (ok) return { proxy: config.proxy, source: '配置指定' };
    if (!force) console.warn(`配置的代理 ${config.proxy} 当前不可用，尝试自动探测`);
  }
  if (!force && config.resolvedProxy) {
    const parsed = new URL(config.resolvedProxy);
    const alive = await tcpReachable(parsed.hostname, Number(parsed.port) || 80);
    if (alive && (await testProxy(config.resolvedProxy))) {
      return { proxy: config.resolvedProxy, source: '缓存' };
    }
  }
  const detected = await detectProxy({ verbose });
  config.resolvedProxy = detected.proxy;
  return detected;
}
