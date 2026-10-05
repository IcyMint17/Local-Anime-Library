#!/usr/bin/env node
/**
 * Command line entry point: parses flags, starts the app and keeps the process
 * alive until Ctrl+C. The desktop build uses src/app.js directly instead.
 */
import { startLibraryApp } from './app.js';

function parseArgs(argv) {
  const args = { scan: false, port: null, host: null, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--scan') args.scan = true;
    else if (value === '--no-open') args.open = false;
    else if (value === '--port') args.port = Number(argv[++i]);
    else if (value === '--host') args.host = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const app = await startLibraryApp({
  port: args.port,
  host: args.host,
  scanOnStart: args.scan,
  openBrowser: args.open,
});

const { seriesCount, lastScan, dbPath, scanDirs } = app.summary();
console.log('');
console.log('  本地番剧媒体库管理器已启动');
console.log(`  地址: ${app.url}`);
console.log(`  数据库: ${dbPath}`);
console.log(`  库中番剧: ${seriesCount} 部${lastScan ? `（上次扫描 ${lastScan.finished_at}）` : '（还没有扫描过）'}`);
console.log(`  扫描目录: ${scanDirs.join(', ')}`);
console.log('');
console.log('  在浏览器里点击「扫描」即可开始整理，Ctrl+C 退出。');
console.log('');

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n正在关闭…');
    await app.close();
    process.exit(0);
  });
}

process.on('unhandledRejection', (error) => {
  console.error('未处理的异常:', error);
});
