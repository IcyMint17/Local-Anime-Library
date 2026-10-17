/**
 * The whole application as a reusable component.
 *
 * `src/main.js` (the CLI) and the Electron desktop shell both call
 * `startLibraryApp()` — the desktop build passes its own port and data
 * directory, the CLI passes the ones from config.json.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, ensureDirs, loadConfig, resolveProxy, saveConfig } from './config.js';
import { openDatabase, getCache, setCache, lastScanRun, listSeries } from './db/repo.js';
import { BangumiClient } from './meta/bangumi.js';
import { runScan } from './scan/pipeline.js';
import { sanitizeAllParts } from './library/parts.js';
import { createRoutes } from './api/routes.js';
import { createServer } from './server.js';

// node:sqlite is stable enough for us but still prints an experimental warning.
let warningsSilenced = false;
export function silenceSqliteWarning() {
  if (warningsSilenced) return;
  warningsSilenced = true;
  const originalEmit = process.emit;
  process.emit = function emit(name, data, ...rest) {
    if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(String(data.message))) {
      return false;
    }
    return originalEmit.call(process, name, data, ...rest);
  };
}

function openBrowser(url) {
  const options = { windowsHide: true };
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], options, () => {});
  else if (process.platform === 'darwin') execFile('open', [url], options, () => {});
  else execFile('xdg-open', [url], options, () => {});
}

function createScanController({ db, config, client, coversDir, logger }) {
  let running = false;
  let progress = { phase: 'idle' };
  let last = null;
  const listeners = new Set();

  const snapshot = () => ({ running, progress, last });
  const broadcast = () => {
    const payload = snapshot();
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        // A dead SSE connection must never break the scan itself.
      }
    }
  };

  return {
    isRunning: () => running,
    status: snapshot,
    /** Lets the SSE endpoint push progress instead of the UI polling for it. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      if (running) return last;
      running = true;
      progress = { phase: 'starting' };
      broadcast();
      try {
        last = await runScan({
          db,
          config,
          client,
          coversDir,
          onProgress: (update) => {
            progress = update;
            broadcast();
          },
        });
        progress = { phase: 'done', summary: last };
        logger.log?.(
          `扫描完成: ${last.groups} 组（自动匹配 ${last.matched}，待确认 ${last.unmatched}），耗时 ${last.seconds}s`
        );
        return last;
      } catch (error) {
        progress = { phase: 'error', message: error.message };
        logger.error?.('扫描失败:', error.message);
        throw error;
      } finally {
        running = false;
        broadcast();
      }
    },
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.port]        0 lets the OS pick a free port.
 * @param {number} [options.scanOnStart] run a scan as soon as the server is up
 * @param {string} [options.dataDir]     override where library.db / covers live
 * @param {boolean} [options.openBrowser] leave false for a desktop shell
 * @returns {Promise<{url:string, port:number, config:object, db:object, close:Function}>}
 */
export async function startLibraryApp(options = {}) {
  const {
    port = null,
    host = null,
    dataDir = null,
    scanOnStart = false,
    openBrowser: shouldOpenBrowser = false,
    logger = console,
  } = options;

  if (dataDir) process.env.ANIME_LIBRARY_DATA = dataDir;
  silenceSqliteWarning();

  const paths = dataPaths();
  ensureDirs();
  const config = loadConfig();
  config.coversDir = paths.coversDir;
  config.dataDir = paths.dataDir;

  const db = openDatabase(paths.dbPath);

  // Older scans could attach a neighbouring show as a "sibling part" when it
  // merely filled a numeric gap. Remove those rows once, at startup, so the
  // detail page stops listing another series' episodes as missing.
  const prunedParts = sanitizeAllParts(db);
  if (prunedParts > 0) {
    logger.log?.(`清理了 ${prunedParts} 个误挂的 Bangumi 分卷`);
  }

  const { proxy, source } = await resolveProxy(config, { force: !config.resolvedProxy });
  config.resolvedProxy = proxy;
  saveConfig(config);
  // Runtime overrides apply to this launch only — they must not be written back.
  // Port 0 is meaningful: let the OS pick a free one (the desktop shell does).
  if (Number.isFinite(port)) config.server.port = port;
  if (host) config.server.host = host;
  logger.log?.(`元数据网络: ${proxy ? `${proxy} (${source})` : '直连'}`);

  const client = new BangumiClient({
    proxy,
    userAgent: config.metadata.userAgent,
    accessToken: config.metadata.accessToken,
    minIntervalMs: config.metadata.requestIntervalMs,
    cache: {
      get: (key) => getCache(db, key)?.value ?? null,
      set: (key, value) => setCache(db, key, value),
    },
  });

  const scanController = createScanController({ db, config, client, coversDir: paths.coversDir, logger });
  const { routes } = createRoutes({ db, client, config, saveConfig, scanController });
  const server = createServer({
    routes,
    publicDir: paths.publicDir,
    coversDir: paths.coversDir,
    scanController,
    backgroundProvider: () => {
      const name = config.appearance?.background;
      if (!name) return null;
      const file = path.join(paths.dataDir, name);
      return fs.existsSync(file) ? file : null;
    },
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, resolve);
  });

  const actualPort = server.address().port;
  const url = `http://${config.server.host}:${actualPort}`;

  if (shouldOpenBrowser && config.server.openBrowser) openBrowser(url);
  if (scanOnStart || listSeries(db).length === 0) {
    scanController.start().catch(() => {});
  }

  let closed = false;
  return {
    url,
    port: actualPort,
    config,
    db,
    paths,
    scanController,
    client,
    summary() {
      const lastScan = lastScanRun(db);
      return {
        seriesCount: listSeries(db).length,
        lastScan,
        dataDir: paths.dataDir,
        dbPath: paths.dbPath,
        scanDirs: config.scan.dirs,
        proxy,
        proxySource: source,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(resolve));
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}
