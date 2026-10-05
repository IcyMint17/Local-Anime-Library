/**
 * Entry point: load config, open the database, resolve the network proxy,
 * start the HTTP server and optionally run a scan.
 */
import { execFile } from 'node:child_process';
import {
  COVERS_DIR,
  DB_PATH,
  PUBLIC_DIR,
  ROOT,
  ensureDirs,
  loadConfig,
  resolveProxy,
  saveConfig,
} from './config.js';
import { openDatabase, getCache, setCache, lastScanRun, listSeries } from './db/repo.js';
import { BangumiClient } from './meta/bangumi.js';
import { runScan } from './scan/pipeline.js';
import { createRoutes } from './api/routes.js';
import { createServer } from './server.js';

// node:sqlite is stable enough for us but still prints an experimental warning.
const originalEmit = process.emit;
process.emit = function emit(name, data, ...rest) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(String(data.message))) {
    return false;
  }
  return originalEmit.call(process, name, data, ...rest);
};

function parseArgs(argv) {
  const args = { scan: false, port: null, host: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--scan') args.scan = true;
    else if (value === '--no-open') args.open = false;
    else if (value === '--port') args.port = Number(argv[++i]);
    else if (value === '--host') args.host = argv[++i];
  }
  return args;
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
  return {
    isRunning: () => running,
    status: () => ({ running, progress, last }),
    async start() {
      if (running) return last;
      running = true;
      progress = { phase: 'starting' };
      try {
        last = await runScan({
          db,
          config,
          client,
          coversDir,
          onProgress: (update) => {
            progress = update;
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
      }
    },
  };
}

const args = parseArgs(process.argv.slice(2));

ensureDirs();
const config = loadConfig();
config.coversDir = COVERS_DIR;

const db = openDatabase(DB_PATH);

console.log('正在检测网络代理…');
const { proxy, source } = await resolveProxy(config, { force: !config.resolvedProxy });
config.resolvedProxy = proxy;
saveConfig(config);
// Command line overrides apply to this run only — they must not be written back
// into config.json.
if (args.port) config.server.port = args.port;
if (args.host) config.server.host = args.host;
console.log(`元数据网络: ${proxy ? `${proxy} (${source})` : '直连'}`);

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

const scanController = createScanController({ db, config, client, coversDir: COVERS_DIR, logger: console });
const { routes } = createRoutes({
  db,
  client,
  config,
  saveConfig,
  scanController,
});

const server = createServer({ routes, publicDir: PUBLIC_DIR, coversDir: COVERS_DIR });
const url = `http://${config.server.host}:${config.server.port}`;

server.listen(config.server.port, config.server.host, () => {
  const seriesCount = listSeries(db).length;
  const lastScan = lastScanRun(db);
  console.log('');
  console.log('  本地番剧媒体库管理器已启动');
  console.log(`  地址: ${url}`);
  console.log(`  数据库: ${DB_PATH}`);
  console.log(`  库中番剧: ${seriesCount} 部${lastScan ? `（上次扫描 ${lastScan.finished_at}）` : '（还没有扫描过）'}`);
  console.log(`  扫描目录: ${config.scan.dirs.join(', ')}`);
  console.log('');
  console.log('  在浏览器里点击「扫描」即可开始整理，Ctrl+C 退出。');
  console.log('');

  if (args.open !== false && config.server.openBrowser) openBrowser(url);
  if (args.scan || seriesCount === 0) {
    scanController.start().catch(() => {});
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n正在关闭…');
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 1500);
  });
}

process.on('unhandledRejection', (error) => {
  console.error('未处理的异常:', error);
});

export { ROOT };
