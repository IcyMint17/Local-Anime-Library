/**
 * Electron desktop shell.
 *
 * It reuses the exact same backend as the browser version — no fork of the
 * server code. The only differences are the port (an OS-assigned free one) and
 * the data directory, which must live in the user profile because the app
 * bundle itself is read-only.
 */
import { app, BrowserWindow, Menu, shell, dialog, session, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cacheBytes, clearProfileCaches, clearProfileCachesSync, formatBytes } from './cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Development layout: this file sits in desktop/ and the app lives one level up.
// Packaged layout: electron-packager puts main.mjs at the root of app.asar, so
// src/ and public/ are right next to it.
const appRoot = fs.existsSync(path.join(here, 'src', 'app.js')) ? here : path.resolve(here, '..');

// Keep the profile folder ASCII even though the window title is Chinese.
app.setName('AnimeLibrary');

/**
 * Quiet Chromium's background services.
 *
 * A stock Electron profile runs a handful of services that wake up on their own
 * schedule: component updates, domain reliability pings, translate and feed
 * suggestions, hyperlink auditing. None of them can do anything useful for an
 * app whose UI comes from 127.0.0.1, and each one costs profile writes and
 * network chatter at startup, so they are all switched off here.
 *
 * Note for anyone chasing task-manager "disk" numbers: this does not change
 * them. Those counters include named-pipe traffic, and Chromium's internal IPC
 * dwarfs everything on this list — measured at roughly 6 KB/s per idle window,
 * with zero files touched. The README has the details.
 */
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch(
  'disable-features',
  'Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions'
);

const dataDir = path.join(app.getPath('userData'), 'library');
const configPath = path.join(dataDir, 'config.json');
const logPath = path.join(app.getPath('userData'), 'startup.log');
process.env.ANIME_LIBRARY_ROOT = appRoot;
process.env.ANIME_LIBRARY_DATA = dataDir;
process.env.ANIME_LIBRARY_CONFIG = configPath;
fs.mkdirSync(dataDir, { recursive: true });

/**
 * Start from an empty cache.
 *
 * The UI is served from localhost and every cover the library needs is already
 * stored in `library/covers/`, so a persistent Chromium cache only ever
 * accumulates duplicates — the match dialog's candidate thumbnails alone ran
 * the author's profile up to 380 MB. Purging before Chromium opens the profile
 * keeps it at a few megabytes no matter how the app is used, and it also cleans
 * up whatever an earlier version left behind.
 */
if (process.env.ANIME_LIBRARY_KEEP_CACHE !== '1') {
  const swept = clearProfileCachesSync(app.getPath('userData'));
  if (swept.before > 0) {
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] 启动前清理缓存 ${formatBytes(swept.before)} → ${formatBytes(swept.after)}\n`,
      'utf8'
    );
  }
}

/**
 * A packaged windowed app has nowhere to print, so startup problems would
 * otherwise be invisible. Everything goes to %APPDATA%\AnimeLibrary\startup.log.
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch {
    /* logging must never break startup */
  }
  console.log(message);
}

log(`启动 v${app.getVersion()} · Electron ${process.versions.electron} · Node ${process.versions.node}`);
log(`appRoot = ${appRoot}`);
log(`dataDir = ${dataDir}`);

// First run inherits the scan folders from the copy that ships with the app, so
// the desktop build does not start with an empty configuration.
if (!fs.existsSync(configPath)) {
  const bundled = path.join(appRoot, 'config.json');
  if (fs.existsSync(bundled)) {
    try {
      fs.copyFileSync(bundled, configPath);
    } catch {
      /* fall back to the built-in defaults */
    }
  }
}

let handle = null;
let mainWindow = null;
let closing = false;

/** Loaded lazily so the environment above is already in place. */
async function loadApp() {
  // Resolve through appRoot rather than ".." — inside app.asar this file sits at
  // the archive root, so a relative parent would escape the archive entirely.
  const entry = pathToFileURL(path.join(appRoot, 'src', 'app.js')).href;
  const module = await import(entry);
  return module.startLibraryApp;
}

/**
 * Tells the page whether the window is maximised, so the title bar can swap the
 * maximise button for a restore button. Sent on every window state change and
 * once more after each load (the listener only exists in the page).
 */
function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
}

// The window buttons in the page's title bar. Registered once for the app, the
// handlers always act on whatever `mainWindow` currently is.
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('window:menu', () => {
  // A frameless window has nowhere to render a menu bar, so the topbar's menu
  // button pops the same application menu up as a context menu.
  const menu = Menu.getApplicationMenu();
  if (menu) menu.popup({ window: mainWindow ?? undefined });
});
ipcMain.handle('window:get-state', () => ({ maximized: Boolean(mainWindow?.isMaximized()) }));

function createWindow(url) {
  const iconFile = path.join(here, 'icon.ico');
  const preloadPath = path.join(here, 'preload.cjs');
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 940,
    minHeight: 640,
    show: false,
    // The page draws its own title bar (drag region + window buttons), so the
    // native one would only be a second, differently styled strip above it.
    frame: false,
    backgroundColor: '#0c0e13',
    title: '本地番剧媒体库',
    autoHideMenuBar: true,
    ...(fs.existsSync(iconFile) ? { icon: iconFile } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      ...(fs.existsSync(preloadPath) ? { preload: preloadPath } : {}),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);
  mainWindow.webContents.on('did-finish-load', () => {
    log('界面已加载完成');
    sendWindowState();
  });
  for (const event of ['maximize', 'unmaximize', 'restore']) {
    mainWindow.on(event, sendWindowState);
  }
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    log(`界面加载失败: ${code} ${description}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`渲染进程退出: ${details.reason}`);
  });
  mainWindow.on('closed', () => {
    log('窗口已关闭');
    mainWindow = null;
  });

  // Bangumi links and any other external URL open in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) shell.openExternal(target);
    }
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [{ role: 'quit', label: '退出' }],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '重新载入' },
          { role: 'forceReload', label: '强制重新载入' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
      {
        label: '帮助',
        submenu: [
          {
            label: '清理缓存…',
            click: async () => {
              const userData = app.getPath('userData');
              const size = cacheBytes(userData);
              const { response } = await dialog.showMessageBox(mainWindow, {
                type: 'question',
                buttons: ['清理', '取消'],
                defaultId: 0,
                cancelId: 1,
                title: '清理缓存',
                message: `删除 Chromium 的缓存文件（${formatBytes(size)}）？`,
                detail: '只删缓存。番剧库、封面、观看记录、设置和背景图都不会动；缓存会在需要时自动重建。',
              });
              if (response !== 0) return;
              const result = await clearProfileCaches(userData, { session: session.defaultSession });
              log(`清理缓存: ${formatBytes(result.before)} → ${formatBytes(result.after)}`);
              await dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: '清理缓存',
                message: `已释放 ${formatBytes(Math.max(0, result.before - result.after))}`,
                detail: result.skipped.length
                  ? `还有 ${result.skipped.join('、')} 正在被占用，下次启动时会自动清掉。`
                  : `当前缓存占用 ${formatBytes(result.after)}。`,
              });
            },
          },
          {
            label: '打开数据文件夹',
            click: () => shell.openPath(dataDir),
          },
          {
            label: '关于',
            click: () =>
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: '关于',
                message: '本地番剧媒体库',
                detail: `版本 ${app.getVersion()}\nElectron ${process.versions.electron}\nNode ${process.versions.node}\n\n数据目录：${dataDir}`,
                buttons: ['好'],
              }),
          },
        ],
      },
    ])
  );
}

async function boot() {
  const startLibraryApp = await loadApp();
  log('已加载后端模块，正在启动服务…');
  handle = await startLibraryApp({ port: 0, dataDir, logger: console });
  log(`服务已启动: ${handle.url}`);
  log(`数据目录: ${dataDir}`);
  buildMenu();
  createWindow(handle.url);
}

function fatal(error) {
  log(`启动失败: ${error?.stack ?? error}`);
  dialog.showErrorBox('启动失败', `${error?.stack ?? error}\n\n日志：${logPath}`);
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(boot).catch(fatal);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && handle) createWindow(handle.url);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (closing || !handle) return;
    event.preventDefault();
    closing = true;
    handle
      .close()
      .catch(() => {})
      .finally(() => app.quit());
  });
}
