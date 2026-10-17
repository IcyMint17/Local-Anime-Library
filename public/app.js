/* 本地番剧媒体库管理器 — 前端（原生 JS，无构建步骤）
 *
 * 结构：顶栏 + 页面容器 + 悬浮 Dock。每个页面独立渲染，数据来自
 * /api/library 与 /api/timeline；详情和匹配对话框仍是覆盖层。
 */

const state = {
  page: 'home',
  loaded: false,
  loadError: null,
  items: [],
  recent: [],
  stats: {},
  lastScan: null,
  timeline: { events: [], upcoming: [], additions: [] },
  scan: { running: false, progress: null, last: null },
  appearance: { hasImage: false, url: null, blur: 0, brightness: 1 },
  settings: null,
  settingsTab: 'appearance',
  theme: null,
  mode: 'dark',
  dock: 'bottom',
  glass: 26,
  additionsExpanded: false,
  // library filters
  filter: 'all',
  type: 'all',
  year: 'all',
  sort: 'recent',
  view: 'grid',
  query: '',
  // home + favourites
  homeTab: 'all',
  favType: 'all',
  calendar: { year: new Date().getFullYear(), month: new Date().getMonth(), selected: null },
  detail: null,
  detailTab: 'episodes',
  detailGroups: null,
  pendingCandidate: null,
};

const $ = (id) => document.getElementById(id);
const pagesEl = $('pages');
const overlay = $('overlay');
const overlayPanel = $('overlayPanel');
const fileOverlay = $('fileOverlay');
const filePanel = $('filePanel');

/* ------------------------------------------------------------- icons */

const ICONS = {
  home: '<path d="M3.6 10.5 12 3.8l8.4 6.7V20a1 1 0 0 1-1 1h-4.9v-6.2H9.5V21H4.6a1 1 0 0 1-1-1z"/>',
  timeline: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.5V12l3.1 1.9"/>',
  library:
    '<rect x="3.4" y="3.4" width="7.2" height="7.2" rx="2.1"/><rect x="13.4" y="3.4" width="7.2" height="7.2" rx="2.1"/><rect x="3.4" y="13.4" width="7.2" height="7.2" rx="2.1"/><rect x="13.4" y="13.4" width="7.2" height="7.2" rx="2.1"/>',
  heart:
    '<path d="M12 20.3 4.9 13.5a4.5 4.5 0 0 1 0-6.4 4.5 4.5 0 0 1 6.4 0l.7.7.7-.7a4.5 4.5 0 0 1 6.4 0 4.5 4.5 0 0 1 0 6.4z"/>',
  circle: '<circle cx="12" cy="12" r="7.8"/>',
  heartSolid:
    '<path d="M12 20.3 4.9 13.5a4.5 4.5 0 0 1 0-6.4 4.5 4.5 0 0 1 6.4 0l.7.7.7-.7a4.5 4.5 0 0 1 6.4 0 4.5 4.5 0 0 1 0 6.4z" fill="currentColor" stroke="none"/>',
  settings:
    '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>',
  search: '<circle cx="11" cy="11" r="6.6"/><path d="m16 16 4.6 4.6"/>',
  play: '<path d="M8.2 5.4v13.2L19 12z" fill="currentColor" stroke="none"/>',
  check: '<path d="M4.6 12.4 9.4 17.2 19.6 6.8"/>',
  chevronRight: '<path d="m9.2 5.4 6.6 6.6-6.6 6.6"/>',
  chevronLeft: '<path d="m14.8 5.4-6.6 6.6 6.6 6.6"/>',
  arrowRight: '<path d="M4.2 12h15.2"/><path d="m13.6 6.2 5.8 5.8-5.8 5.8"/>',
  calendar:
    '<rect x="3.4" y="4.8" width="17.2" height="15.6" rx="3"/><path d="M7.6 3.2v3.2M16.4 3.2v3.2M3.4 9.6h17.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  list: '<path d="M9 6.2h11.4M9 12h11.4M9 17.8h11.4"/><circle cx="4.6" cy="6.2" r="1.15"/><circle cx="4.6" cy="12" r="1.15"/><circle cx="4.6" cy="17.8" r="1.15"/>',
  star: '<path d="m12 3.7 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  alert: '<path d="M12 4.2 2.8 19.6a1.1 1.1 0 0 0 .95 1.7h16.5a1.1 1.1 0 0 0 .95-1.7z"/><path d="M12 9.6v4.4"/><circle cx="12" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
  folder: '<path d="M3.4 7.6a2 2 0 0 1 2-2h3.2l1.8 2.2h7.2a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z"/>',
  globe: '<circle cx="12" cy="12" r="8.6"/><path d="M3.6 12h16.8M12 3.4a13 13 0 0 1 0 17.2 13 13 0 0 1 0-17.2z"/>',
  sliders: '<path d="M5 6.5h14M5 12h14M5 17.5h14"/><circle cx="9.4" cy="6.5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="17.5" r="2"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.8v4.7h-4.7"/>',
  bell: '<path d="M18.2 9.4a6.2 6.2 0 1 0-12.4 0c0 7-2.6 7.6-2.6 7.6h17.6s-2.6-.6-2.6-7.6"/><path d="M13.8 20.4a2 2 0 0 1-3.6 0"/>',
  keyboard:
    '<rect x="2.6" y="6" width="18.8" height="12" rx="3"/><path d="M6.4 10h.02M10 10h.02M13.6 10h.02M17.2 10h.02M6.4 13.6h.02M10 13.6h.02M13.6 13.6h.02M17.2 13.6h.02M8 17h8"/>',
  sparkles:
    '<path d="m12 3.4 1.5 3.9 3.9 1.5-3.9 1.5L12 14.2l-1.5-3.9L6.6 8.8l3.9-1.5z"/><path d="m18.6 14.4.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/>',
  trash: '<path d="M4.4 7h15.2M9.4 7V4.8h5.2V7M6.4 7l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 7"/>',
  image: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="3"/><circle cx="8.6" cy="9.8" r="1.7"/><path d="m5.4 17.6 4.7-5 3.7 3.7 2.6-2.6 2.2 2.2"/>',
  download: '<path d="M12 3.8v10.8"/><path d="m7.6 10.4 4.4 4.4 4.4-4.4"/><path d="M4.4 20.2h15.2"/>',
  close: '<path d="m5.6 5.6 12.8 12.8M18.4 5.6 5.6 18.4"/>',
  menu: '<circle cx="12" cy="5" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.9" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.7v2.2M12 19.1v2.2M4.7 12H2.5M21.5 12h-2.2M6.9 6.9 5.3 5.3M18.7 18.7l-1.6-1.6M6.9 17.1l-1.6 1.6M18.7 5.3l-1.6 1.6"/>',
  moon: '<path d="M20.4 14.4A8.6 8.6 0 0 1 9.6 3.6a8.6 8.6 0 1 0 10.8 10.8z"/>',
  minimize: '<path d="M3 8h10"/>',
  maximize: '<rect x="3.3" y="3.3" width="9.4" height="9.4" rx="1.2"/>',
  restore:
    '<rect x="3.2" y="5.6" width="7.2" height="7.2" rx="1.2"/><path d="M5.6 5.6V4.4a1.2 1.2 0 0 1 1.2-1.2h4.8a1.2 1.2 0 0 1 1.2 1.2v4.8a1.2 1.2 0 0 1-1.2 1.2h-1.2"/>',
};

const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
const WINDOW_ICONS = {
  menu: '<circle cx="8" cy="3.6" r="1.5" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="8" cy="12.4" r="1.5" fill="currentColor" stroke="none"/>',
  minimize: '<path d="M3 8h10"/>',
  maximize: '<rect x="3.3" y="3.3" width="9.4" height="9.4" rx="1.2"/>',
  restore:
    '<rect x="3.2" y="5.6" width="7.2" height="7.2" rx="1.2"/><path d="M5.6 5.6V4.4a1.2 1.2 0 0 1 1.2-1.2h4.8a1.2 1.2 0 0 1 1.2 1.2v4.8a1.2 1.2 0 0 1-1.2 1.2h-1.2"/>',
  close: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
};
const windowIcon = (name) => `<svg viewBox="0 0 16 16" aria-hidden="true">${WINDOW_ICONS[name] ?? ''}</svg>`;

const PAGES = [
  { id: 'home', label: '首页', icon: 'home' },
  { id: 'timeline', label: '时间线', icon: 'timeline' },
  { id: 'library', label: '媒体库', icon: 'library' },
  { id: 'favorites', label: '收藏', icon: 'heart' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

const THEMES = [
  { id: 'sakura', label: '樱粉', accent: '#ff6fa5', accent2: '#b06bff' },
  { id: 'indigo', label: '靛蓝', accent: '#6c8cff', accent2: '#a06cff' },
  { id: 'mint', label: '薄荷', accent: '#3fd0a8', accent2: '#4fa8ff' },
  { id: 'amber', label: '琥珀', accent: '#f0a336', accent2: '#ff6f5a' },
  { id: 'violet', label: '紫罗兰', accent: '#9b6cff', accent2: '#e070ff' },
  { id: 'graphite', label: '石墨', accent: '#8d9bb5', accent2: '#c0c9dc' },
];

const STORE = {
  theme: 'anime-library.theme',
  mode: 'anime-library.mode',
  dock: 'anime-library.dock',
  glass: 'anime-library.glass',
};

const STATUS_LABEL = { none: '未看', watching: '观看中', completed: '已看完' };
const KIND_LABEL = { episode: '番剧', movie: '剧场版', special: '特别篇' };
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];

/* ------------------------------------------------------------ small utils */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const pad2 = (n) => String(n).padStart(2, '0');

function dateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const addDays = (date, amount) => {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
};

function weekStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const fmtDate = (value) => {
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

/** YYYY-MM-DD is parsed as local midnight, not UTC. */
const fmtDayKey = (key) => {
  const d = new Date(`${key}T00:00:00`);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

const fmtTime = (value) => {
  const d = new Date(value);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const fmtDateTime = (value) => {
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const firstChar = (text) => String(text ?? '?').trim().slice(0, 1) || '?';

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Pull the few facts a viewer cares about out of a release filename. The full
 * name (fansub tags, CRC, audio channels…) stays in the advanced dialog.
 */
function parseFileMeta(file) {
  const name = String(file?.name ?? '');
  const resolution = name.match(/\b(2160p|1440p|1080p|720p|480p)\b/i)?.[1]?.toLowerCase() ?? null;
  const codec = /HEVC|H\.?265|x265/i.test(name)
    ? 'HEVC'
    : /AVC|H\.?264|x264/i.test(name)
      ? 'AVC'
      : /AV1/i.test(name)
        ? 'AV1'
        : null;
  const tenBit = /10-?bit|main\s*10/i.test(name);
  const audio = name.match(/\b(AAC|FLAC|EAC3|AC3|DTS|Opus|MP3)\b/i)?.[1]?.toUpperCase() ?? null;
  const subtitle = /CHS\s*&\s*CHT|简繁|简日双语|CHS&CHT/i.test(name)
    ? '简繁'
    : /\bCHS\b|\bGB\b|简体/i.test(name)
      ? '简体'
      : /\bCHT\b|BIG5|繁体/i.test(name)
        ? '繁体'
        : null;
  const extension = String(file?.ext ?? name.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '').replace(/^\./, '');
  const container = extension ? extension.toUpperCase() : null;
  const video = codec ? `${codec}${tenBit ? ' Main10' : ''}` : null;
  const compact = [resolution, codec, formatSize(file?.size)].filter(Boolean).join(' · ');

  return { resolution, codec, audio, subtitle, container, video, compact };
}

function hashHue(text) {
  let hash = 0;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

function posterFallback(title) {
  const hue = hashHue(title);
  return `background: linear-gradient(150deg, hsl(${hue} 45% 30%), hsl(${(hue + 48) % 360} 52% 16%))`;
}

function coverMarkup(item, cls = '') {
  const url = item?.coverUrl;
  if (url) return `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" />`;
  return `<span class="cover-fallback ${cls}" style="${posterFallback(item?.title_cn ?? item?.title ?? '')}">${esc(
    firstChar(item?.title_cn ?? item?.title)
  )}</span>`;
}

function readStore(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — preferences simply do not persist */
  }
}

function hexToRgba(hex, alpha) {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value;
  const number = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(number)) return `rgba(255, 111, 165, ${alpha})`;
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, isError ? 5200 : 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text };
  }
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
  return payload;
}

/* ------------------------------------------------------------ preferences */

function applyTheme(theme) {
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.accent);
  root.setProperty('--accent-2', theme.accent2);
  root.setProperty('--accent-soft', hexToRgba(theme.accent, 0.16));
  root.setProperty('--accent-glow', hexToRgba(theme.accent, 0.42));
  state.theme = theme;
  writeStore(STORE.theme, JSON.stringify(theme));
}

function currentTheme() {
  const raw = readStore(STORE.theme);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.accent) return parsed;
    } catch {
      /* fall through to the default */
    }
  }
  return THEMES[0];
}

function setTheme(theme, { persist = false } = {}) {
  applyTheme(theme);
  if (persist) savePreferences({ theme });
}

function applyMode(mode, { persist = false } = {}) {
  const next = mode === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.mode = next;
  state.mode = next;
  writeStore(STORE.mode, next);
  if (persist) savePreferences({ mode: next });
  const button = $('btnMode');
  if (button) {
    button.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
    button.title = next === 'dark' ? '切换到亮色' : '切换到深色';
  }
}

function applyDock(dock, { persist = false } = {}) {
  const next = ['left', 'right'].includes(dock) ? dock : 'bottom';
  document.documentElement.dataset.dock = next;
  state.dock = next;
  writeStore(STORE.dock, next);
  if (persist) savePreferences({ dock: next });
}

function applyGlass(value, { persist = false } = {}) {
  const next = Math.max(0, Math.min(48, Number(value) || 0));
  document.documentElement.style.setProperty('--blur', `${next}px`);
  state.glass = next;
  writeStore(STORE.glass, String(next));
  if (persist) savePreferences({ glass: next });
}

function savePreferences(patch) {
  api('/api/preferences', { method: 'POST', body: patch }).catch(() => {});
}

async function loadPreferences() {
  try {
    const preferences = await api('/api/preferences');
    if (preferences.theme) setTheme(preferences.theme);
    applyMode(preferences.mode);
    if (preferences.dock) applyDock(preferences.dock);
    if (Number.isFinite(Number(preferences.glass))) applyGlass(preferences.glass);
    if (state.page === 'settings') renderSettingsBody();
  } catch {
    /* localStorage is a good enough fallback */
  }
}

function currentMode() {
  return readStore(STORE.mode) === 'light' ? 'light' : 'dark';
}

/* ------------------------------------------------------------- background */

function applyAppearance(appearance) {
  const { hasImage = false, url = null, blur = 0, brightness = 1 } = appearance ?? {};
  const root = document.documentElement;
  const show = Boolean(hasImage) && Boolean(url);
  root.classList.toggle('has-background', show);
  root.style.setProperty('--bg-blur', `${Number(blur) || 0}px`);
  root.style.setProperty('--bg-brightness', String(Number(brightness) || 1));
  if (show) root.style.setProperty('--bg-image', `url("${url}")`);
  else root.style.removeProperty('--bg-image');
  state.appearance = { hasImage: show, url, blur: Number(blur) || 0, brightness: Number(brightness) || 1 };
}

async function loadAppearance() {
  try {
    applyAppearance(await api('/api/appearance'));
    if (state.page === 'settings') renderSettings();
  } catch {
    /* an unset background is not an error */
  }
}

async function prepareBackgroundImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });

  const image = await new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve(probe);
    probe.onerror = () => reject(new Error('这不是有效的图片文件'));
    probe.src = dataUrl;
  });

  const MAX = 2560;
  const scale = Math.min(1, MAX / Math.max(image.width, image.height));
  if (scale === 1 && dataUrl.length < 3.2 * 1024 * 1024) return dataUrl;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.86);
}

/* ---------------------------------------------------------- window chrome */

function setupWindowControls() {
  const shell = window.desktopWindow;
  if (!shell) return;

  document.documentElement.classList.add('is-desktop-shell');

  const maxButton = $('winMax');
  $('winMin').innerHTML = windowIcon('minimize');
  $('winClose').innerHTML = windowIcon('close');
  $('btnAppMenu').innerHTML = windowIcon('menu');

  $('winMin').addEventListener('click', () => shell.minimize());
  maxButton.addEventListener('click', () => shell.toggleMaximize());
  $('winClose').addEventListener('click', () => shell.close());
  $('btnAppMenu').addEventListener('click', () => shell.openMenu());

  const applyState = (windowState) => {
    const maximized = Boolean(windowState?.maximized);
    document.documentElement.classList.toggle('is-maximized', maximized);
    maxButton.innerHTML = maximized ? windowIcon('restore') : windowIcon('maximize');
    maxButton.title = maximized ? '向下还原' : '最大化';
    maxButton.setAttribute('aria-label', maxButton.title);
  };
  applyState(null);
  shell.getState?.().then(applyState).catch(() => {});
  shell.onStateChange?.(applyState);
}

/* --------------------------------------------------------------- routing */

function pageFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGES.some((page) => page.id === raw) ? raw : 'home';
}

function goPage(page, { replace = false } = {}) {
  if (pageFromHash() !== page || location.hash === '') {
    if (replace) history.replaceState(null, '', `#/${page}`);
    else location.hash = `#/${page}`;
  }
  setPage(page);
}

function setPage(page) {
  const changed = state.page !== page;
  state.page = page;
  for (const section of document.querySelectorAll('.page')) {
    section.hidden = section.dataset.page !== page;
  }
  renderDock();
  renderCurrentPage();
  if (changed) pagesEl.scrollTop = 0;
}

function renderCurrentPage() {
  const renderers = {
    home: renderHome,
    timeline: renderTimeline,
    library: renderLibrary,
    favorites: renderFavorites,
    settings: renderSettings,
  };
  renderers[state.page]?.();
}

function renderDock() {
  const dock = $('dock');
  if (!dock) return;
  dock.innerHTML = PAGES.map(
    (page) => `
      <button class="dock-item${page.id === state.page ? ' is-active' : ''}" type="button" data-nav="${page.id}"
        aria-label="${page.label}"${page.id === state.page ? ' aria-current="page"' : ''}>
        <span class="dock-icon">${icon(
          page.id === 'favorites' && page.id === state.page ? 'heartSolid' : page.icon
        )}</span>
        <span class="dock-label">${page.label}</span>
      </button>`
  ).join('');
}

/* ------------------------------------------------------------ data loading */

async function loadData({ quiet = false } = {}) {
  try {
    const [library, timeline] = await Promise.all([api('/api/library'), api('/api/timeline')]);
    state.items = library.items;
    state.recent = library.recent ?? [];
    state.stats = library.stats;
    state.lastScan = library.lastScan;
    state.timeline = timeline ?? { events: [], upcoming: [], additions: [] };
    state.loaded = true;
    state.loadError = null;
    if (state.query) $('search').value = state.query;
    renderCurrentPage();
    renderScanStatus();
  } catch (error) {
    state.loadError = error.message;
    if (!quiet) renderCurrentPage();
  }
}

/* ----------------------------------------------------------- shared pieces */

function loadingMarkup(text = '正在载入…') {
  return `<div class="state-card"><span class="spinner"></span><p>${esc(text)}</p></div>`;
}

function emptyMarkup(iconName, title, text, action = '') {
  return `<div class="empty-state">
    <span class="empty-icon">${icon(iconName)}</span>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    ${action}
  </div>`;
}

function eventsByDay() {
  const map = new Map();
  for (const event of state.timeline.events) {
    const key = dateKey(new Date(event.watchedAt));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return map;
}

function favoriteCount() {
  return state.items.filter((item) => item.favorite).length;
}

const isFavorite = (seriesId) => Boolean(state.items.find((item) => item.id === seriesId)?.favorite);

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function todayLabel() {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${WEEKDAY_CN[d.getDay()]}`;
}

function scanChipMarkup() {
  const { running, progress } = state.scan;
  if (!running) {
    return state.lastScan?.finished_at
      ? `上次扫描 ${fmtDateTime(state.lastScan.finished_at)}`
      : '还没有扫描过';
  }
  const percent =
    progress?.phase === 'match' && progress.total ? Math.round((progress.index / progress.total) * 100) : 8;
  return `<div class="scan-chip"><span class="spinner"></span>
    <div class="scan-chip-main">
      <span>${progress?.phase === 'match' ? `正在识别 ${progress.index}/${progress.total}` : '正在扫描文件…'}</span>
      <span class="scan-bar"><i style="width:${percent}%"></i></span>
    </div>
  </div>`;
}

function renderScanStatus() {
  const el = $('scanStatus');
  if (el) el.innerHTML = scanChipMarkup();
  for (const button of document.querySelectorAll('[data-scan]')) {
    button.disabled = state.scan.running;
    const label = button.querySelector('[data-scan-label]');
    if (label) {
      label.textContent = state.scan.running ? '扫描中…' : button.dataset.scanLabel ?? '扫描媒体库';
    }
    button.classList.toggle('is-running', state.scan.running);
  }
}

/* ------------------------------------------------------------------ cards */

function statusBadge(item) {
  if (item.match_state === 'unmatched') return '<span class="badge badge-warn">待确认</span>';
  if (item.media_kind === 'movie' && item.progress?.status === 'none') {
    return '<span class="badge badge-kind">剧场版</span>';
  }
  const status = item.progress?.status;
  if (status === 'completed') return '<span class="badge badge-ok">已看完</span>';
  if (status === 'watching') return '<span class="badge badge-live">观看中</span>';
  return '';
}

function renderPosterCard(item, { minimal = false } = {}) {
  const progress = item.progress ?? { percent: 0, watched: 0, total: 0, localTotal: 0 };
  const percent = Math.round((progress.percent ?? 0) * 100);
  const favorite = Boolean(item.favorite);
  const total = progress.total || progress.localTotal || 0;
  // The wall only needs the title and how far along it is; ratings live in the
  // detail panel, and status badges are reserved for the dense library view.
  const sub = total ? `${progress.watched ?? 0} / ${total} 集` : `${progress.totalFiles ?? 0} 个文件`;
  const badges = minimal ? '' : statusBadge(item);

  return `
    <article class="poster-card${minimal ? ' is-minimal' : ''}" data-series="${item.id}" tabindex="0" role="button" aria-label="${esc(
      item.title_cn ?? '未命名'
    )}">
      <div class="poster-art">
        ${coverMarkup(item, 'poster-img')}
        <span class="poster-shade"></span>
        ${badges ? `<span class="poster-badges">${badges}</span>` : ''}
        <button class="fav-btn${favorite ? ' is-on' : ''}" type="button" data-favorite="${item.id}"
          title="${favorite ? '取消收藏' : '收藏'}" aria-label="${favorite ? '取消收藏' : '收藏'}" aria-pressed="${favorite}">
          ${icon(favorite ? 'heartSolid' : 'heart')}
        </button>
        <span class="poster-progress"><i style="width:${percent}%"></i></span>
      </div>
      <div class="poster-info">
        <h3 class="poster-name" title="${esc(item.title_cn ?? '')}">${esc(item.title_cn ?? '未命名')}</h3>
        <p class="poster-sub">${esc(sub)}</p>
      </div>
    </article>`;
}

function renderMediaRow(item) {
  const progress = item.progress ?? { percent: 0, watched: 0, total: 0 };
  const percent = Math.round((progress.percent ?? 0) * 100);
  const favorite = Boolean(item.favorite);
  return `
    <article class="media-row" data-series="${item.id}" tabindex="0" role="button">
      <div class="media-row-cover">${coverMarkup(item, 'media-cover-img')}</div>
      <div class="media-row-main">
        <div class="media-row-title">
          <h3>${esc(item.title_cn ?? '未命名')}</h3>
          ${favorite ? `<span class="fav-mark">${icon('heartSolid')}</span>` : ''}
        </div>
        <p class="media-row-orig">${esc(item.title_orig ?? item.source_folder ?? '')}</p>
        <div class="media-row-meta">
          ${statusBadge(item)}
          <span>${KIND_LABEL[item.media_kind] ?? '番剧'}</span>
          ${item.air_date ? `<span>${esc(String(item.air_date).slice(0, 4))}</span>` : ''}
          ${item.rating ? `<span class="rating">★ ${Number(item.rating).toFixed(1)}</span>` : ''}
        </div>
      </div>
      <div class="media-row-progress">
        <span class="media-row-count">${progress.watched ?? 0}<i>/${progress.total || progress.localTotal || 0}</i></span>
        <span class="progress-track"><i style="width:${percent}%"></i></span>
      </div>
      <button class="fav-btn${favorite ? ' is-on' : ''}" type="button" data-favorite="${item.id}"
        title="${favorite ? '取消收藏' : '收藏'}" aria-label="${favorite ? '取消收藏' : '收藏'}" aria-pressed="${favorite}">
        ${icon(favorite ? 'heartSolid' : 'heart')}
      </button>
    </article>`;
}

/* --------------------------------------------------------------- home page */

function homeItems() {
  const filters = {
    all: () => true,
    watching: (item) => item.progress?.status === 'watching',
    completed: (item) => item.progress?.status === 'completed',
    favorites: (item) => item.favorite,
  };
  return state.items
    .filter(filters[state.homeTab] ?? filters.all)
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    .slice(0, 6);
}

/** Only series that still have a main episode left belong in 继续观看. */
function continueItems() {
  return state.recent.filter((entry) => entry.nextEpisode?.number != null).slice(0, 4);
}

function renderHome() {
  const page = $('page-home');
  if (!state.loaded && !state.loadError) {
    page.innerHTML = loadingMarkup('正在整理你的番剧库…');
    return;
  }
  if (state.loadError) {
    page.innerHTML = emptyMarkup('alert', '无法连接后端', state.loadError);
    return;
  }

  const unmatched = state.stats.unmatched ?? state.items.filter((item) => item.match_state === 'unmatched').length;
  const watching = state.items.filter((item) => item.progress?.status === 'watching').length;
  const continues = continueItems();
  const tabs = [
    ['all', '全部'],
    ['watching', '在看'],
    ['completed', '已看完'],
    ['favorites', '收藏'],
  ];

  page.innerHTML = `
    <div class="home-page">
      <section class="home-hero">
        <div class="hero-copy">
          <span class="eyebrow">${icon('sparkles')} 本地番剧媒体库</span>
          <h1>${greeting()}，今天想看点什么？</h1>
          <p class="hero-sub">今天是 ${todayLabel()} · 共 ${state.items.length} 部番剧在库</p>
        </div>
        <div class="hero-chips">
          <span class="stat-chip">${icon('library')}<span><strong>${state.items.length}</strong> 部番剧</span></span>
          <span class="stat-chip">${icon('play')}<span><strong>${watching}</strong> 部在看</span></span>
          <span class="stat-chip${unmatched ? ' is-warn' : ''}">${icon('alert')}<span><strong>${unmatched}</strong> 部待确认</span></span>
        </div>
      </section>

      <div class="home-columns">
        <div class="home-column">
          ${
            continues.length
              ? `<section class="section">
                  <header class="section-head">
                    <h2><span class="section-mark">${icon('play')}</span>继续观看</h2>
                    <button class="text-btn" type="button" data-nav="library">查看全部 ${icon('chevronRight')}</button>
                  </header>
                  <div class="continue-grid">${continues.map(renderContinueCard).join('')}</div>
                </section>`
              : ''
          }

          <section class="section">
            <header class="section-head">
              <h2><span class="section-mark">${icon('library')}</span>我的番剧</h2>
              <div class="segmented segmented--sm">
                ${tabs
                  .map(
                    ([id, label]) =>
                      `<button class="seg-item${state.homeTab === id ? ' is-active' : ''}" type="button"
                        data-home-tab="${id}">${label}<span>${id === 'favorites' ? favoriteCount() : ''}</span></button>`
                  )
                  .join('')}
              </div>
              <button class="text-btn" type="button" data-nav="library">查看全部 ${icon('chevronRight')}</button>
            </header>
            ${
              homeItems().length
                ? `<div class="poster-grid poster-grid--compact">${homeItems()
                    .map((item) => renderPosterCard(item, { minimal: true }))
                    .join('')}</div>`
                : emptyMarkup('heart', '这里还没有番剧', '切换到其他分类，或者先去扫描媒体库。')
            }
          </section>
        </div>

        <aside class="home-rail">
          ${homeTimelineCard()}
          ${homeAdditionsCard()}
        </aside>
      </div>
    </div>`;
}

function renderContinueCard(entry) {
  const progress = entry.progress ?? { percent: 0, watched: 0, total: 0 };
  const next = entry.nextEpisode;
  const percent = Math.round((progress.percent ?? 0) * 100);
  const label = next
    ? next.number != null
      ? `第 ${next.number} 集${next.title ? ` · ${next.title}` : ''}`
      : `特别篇${next.title ? ` · ${next.title}` : ''}`
    : '全部看完了';

  return `
    <article class="continue-card" data-series="${entry.seriesId}" tabindex="0" role="button">
      <div class="continue-art">${coverMarkup(entry, 'continue-img')}</div>
      <span class="continue-scrim"></span>
      <span class="continue-percent">${percent}%</span>
      ${
        next?.fileId
          ? `<button class="continue-play" type="button" data-play-file="${next.fileId}" title="播放下一集" aria-label="播放下一集">${icon(
              'play'
            )}</button>`
          : ''
      }
      <div class="continue-body">
        <h3>${esc(entry.title ?? '未命名')}</h3>
        <p>${esc(label)}</p>
        <span class="progress-track"><i style="width:${percent}%"></i></span>
      </div>
    </article>`;
}

function weekStripMarkup() {
  const start = weekStart(new Date());
  const map = eventsByDay();
  const todayKey = dateKey(new Date());
  const end = addDays(start, 6);
  const range = `${start.getMonth() + 1}月${start.getDate()}日 - ${end.getMonth() + 1}月${end.getDate()}日`;

  return `
    <div class="week-strip-head"><span>本周</span><span>${range}</span></div>
    <div class="week-strip">
      ${WEEKDAY_SHORT.map((label, index) => {
        const day = addDays(start, index);
        const key = dateKey(day);
        const hasEvents = map.has(key);
        return `<button class="week-day${key === todayKey ? ' is-today' : ''}" type="button" data-timeline-day="${key}">
          <span>${label}</span>
          <strong>${day.getDate()}</strong>
          ${hasEvents ? '<i class="week-dot"></i>' : '<i class="week-dot is-empty"></i>'}
        </button>`;
      }).join('')}
    </div>`;
}

function homeTimelineCard() {
  const events = state.timeline.events.slice(0, 3);
  return `
    <section class="rail-card">
      <header class="rail-head">
        <h2>${icon('timeline')}时间线</h2>
        <button class="text-btn" type="button" data-nav="timeline">查看全部 ${icon('chevronRight')}</button>
      </header>
      ${weekStripMarkup()}
      <div class="rail-events">
        ${
          events.length
            ? events.map(renderRailEvent).join('')
            : `<p class="rail-empty">还没有观看记录。勾选一集之后，这里会自动出现。</p>`
        }
      </div>
    </section>`;
}

function renderRailEvent(event) {
  return `
    <button class="rail-event" type="button" data-series="${event.seriesId}">
      <span class="rail-thumb">${coverMarkup(event, 'rail-img')}</span>
      <span class="rail-event-main">
        <strong>${esc(event.title)}</strong>
        <span>${esc(event.label)}${event.episodeTitle ? ` · ${esc(event.episodeTitle)}` : ''}</span>
      </span>
      <span class="rail-event-time">${fmtTime(event.watchedAt)}</span>
    </button>`;
}

function homeAdditionsCard() {
  const all = state.timeline.additions;
  const shown = state.additionsExpanded ? all : all.slice(0, 3);
  const canExpand = all.length > 3;
  return `
    <section class="rail-card">
      <header class="rail-head">
        <h2>${icon('sparkles')}最近添加</h2>
        <div class="rail-head-actions">
          <span class="rail-muted">${all.length} 部</span>
          ${
            canExpand
              ? `<button class="text-btn" type="button" data-additions-toggle>${
                  state.additionsExpanded ? '收起' : '展开'
                }${icon('chevronRight')}</button>`
              : ''
          }
        </div>
      </header>
      <div class="addition-list">
        ${
          shown.length
            ? shown
                .map(
                  (item) => `
                  <button class="addition-row" type="button" data-series="${item.id}">
                    <span class="addition-thumb">${coverMarkup(item, 'addition-img')}</span>
                    <span class="addition-main">
                      <strong>${esc(item.title)}</strong>
                      <span>${KIND_LABEL[item.mediaKind] ?? '番剧'}${item.rating ? ` · ★ ${Number(item.rating).toFixed(1)}` : ''}</span>
                    </span>
                    <span class="addition-date">${fmtDate(item.createdAt)}</span>
                  </button>`
                )
                .join('')
            : `<p class="rail-empty">还没有扫描到番剧。</p>`
        }
      </div>
    </section>`;
}

/* ------------------------------------------------------------ timeline page */

function renderTimeline() {
  const page = $('page-timeline');
  if (!state.loaded) {
    page.innerHTML = loadingMarkup('正在载入时间线…');
    return;
  }

  const { year, month, selected } = state.calendar;
  const map = eventsByDay();
  const selectedEvents = map.get(selected) ?? [];
  const fallback = !selectedEvents.length;
  const shown = fallback ? state.timeline.events.slice(0, 6) : selectedEvents;
  const monthLabel = `${year} 年 ${month + 1} 月`;
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const todayKey = dateKey(new Date());

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7;
  const cells = [];
  for (let i = 0; i < cellCount; i += 1) {
    const day = new Date(year, month, 1 - offset + i);
    const key = dateKey(day);
    const inMonth = day.getMonth() === month;
    const classes = [
      'cal-day',
      inMonth ? '' : 'is-outside',
      key === todayKey ? 'is-today' : '',
      key === selected ? 'is-selected' : '',
      map.has(key) ? 'has-events' : '',
    ]
      .filter(Boolean)
      .join(' ');
    cells.push(
      `<button class="${classes}" type="button" data-calendar-day="${key}">
        <span>${day.getDate()}</span>${map.has(key) ? '<i class="cal-dot"></i>' : ''}
      </button>`
    );
  }

  const selectedDate = new Date(`${selected}T00:00:00`);
  const selectedLabel = `${selectedDate.getMonth() + 1}月${selectedDate.getDate()}日 · ${
    WEEKDAY_CN[selectedDate.getDay()]
  }${selected === todayKey ? ' · 今天' : ''}`;

  page.innerHTML = `
    <div class="timeline-page">
      <header class="page-head">
        <div>
          <span class="eyebrow">${icon('timeline')} 追番日历</span>
          <h1>时间线</h1>
          <p>继续上次的进度，或者翻翻这个月的观看记录。</p>
        </div>
        <button class="btn btn-ghost" type="button" data-timeline-today>${icon('calendar')}回到今天</button>
      </header>

      ${resumeHero()}

      <div class="timeline-grid">
        <section class="calendar-card">
          <header class="calendar-head">
            <div class="calendar-title">
              <strong>${monthLabel}</strong>
              <span>${map.size} 天有观看记录</span>
            </div>
            <div class="calendar-nav">
              <button class="round-btn" type="button" data-calendar-shift="-1" aria-label="上个月">${icon('chevronLeft')}</button>
              <button class="round-btn" type="button" data-calendar-shift="1" aria-label="下个月">${icon('chevronRight')}</button>
            </div>
          </header>
          <div class="calendar-weekdays">${WEEKDAY_SHORT.map((label) => `<span>周${label}</span>`).join('')}</div>
          <div class="calendar-grid">${cells.join('')}</div>
        </section>

        <section class="day-card">
          <header class="day-head">
            <h2>${selectedLabel}</h2>
            <span>${fallback ? '最近记录' : `${shown.length} 条记录`}</span>
          </header>
          ${fallback ? `<p class="day-hint">这一天还没有观看记录，下面是最新的几条。</p>` : ''}
          <div class="timeline-list timeline-list--scroll">
            ${
              shown.length
                ? shown.map(renderTimelineEvent).join('')
                : emptyMarkup('timeline', '还没有观看记录', '在番剧详情里勾选已看，这里就会留下时间线。')
            }
          </div>
        </section>
      </div>

      ${upcomingSection()}
    </div>`;
}

function resumeHero() {
  const entry = state.recent.find((item) => item.nextEpisode?.number != null) ?? state.recent[0] ?? null;
  if (!entry) return '';
  const seriesId = entry.seriesId ?? entry.id;
  const title = entry.title ?? entry.title_cn ?? '未命名';
  const progress = entry.progress ?? { percent: 0, watched: 0, total: 0 };
  const next = entry.nextEpisode;
  const percent = Math.round((progress.percent ?? 0) * 100);
  const label = next
    ? next.number != null
      ? `下一集 第 ${next.number} 集${next.title ? ` · ${next.title}` : ''}`
      : '接下来是特别篇'
    : '全部看完了';

  return `
    <section class="resume-hero">
      <div class="resume-backdrop">${coverMarkup(entry, 'resume-bg-img')}</div>
      <span class="resume-scrim"></span>
      <div class="resume-cover">${coverMarkup(entry, 'resume-cover-img')}</div>
      <div class="resume-copy">
        <span class="eyebrow">${icon('play')} 继续上次观看</span>
        <h2>${esc(title)}</h2>
        <p>${esc(label)}</p>
        <span class="progress-track"><i style="width:${percent}%"></i></span>
        <div class="resume-actions">
          ${
            next?.fileId
              ? `<button class="btn btn-primary btn-sm" type="button" data-play-file="${next.fileId}">${icon('play')}继续观看</button>`
              : ''
          }
          <button class="btn btn-ghost btn-sm" type="button" data-series="${seriesId}">查看详情</button>
        </div>
      </div>
    </section>`;
}

function renderTimelineEvent(event) {
  return `
    <button class="tl-event" type="button" data-series="${event.seriesId}">
      <span class="tl-time">${fmtTime(event.watchedAt)}</span>
      <span class="tl-cover">${coverMarkup(event, 'tl-img')}</span>
      <span class="tl-main">
        <strong>${esc(event.title)}</strong>
        <span>${esc(event.label)}${event.episodeTitle ? ` · ${esc(event.episodeTitle)}` : ''}</span>
        <span class="tl-date">${fmtDate(event.watchedAt)} · ${WEEKDAY_CN[new Date(event.watchedAt).getDay()]}</span>
      </span>
      <span class="tl-state">${event.downloaded ? `${icon('download')} 已下载` : `${icon('check')} 已看`}</span>
    </button>`;
}

function upcomingSection() {
  const upcoming = state.timeline.upcoming;
  if (upcoming.length === 0) return '';
  const byDate = new Map();
  for (const item of upcoming) {
    if (!byDate.has(item.airDate)) byDate.set(item.airDate, []);
    byDate.get(item.airDate).push(item);
  }
  return `
    <section class="upcoming-card">
      <header class="day-head"><h2>${icon('calendar')}未来一周</h2><span>${upcoming.length} 集待播</span></header>
      ${
        upcoming.length
          ? [...byDate.entries()]
              .map(
                ([date, items]) => `
                <div class="upcoming-group">
                  <span class="upcoming-date">${fmtDayKey(date)}<i>${WEEKDAY_CN[new Date(date + 'T00:00:00').getDay()]}</i></span>
                  ${items
                    .map(
                      (item) => `
                      <button class="upcoming-row" type="button" data-series="${item.seriesId}">
                        <span class="upcoming-cover">${coverMarkup(item, 'upcoming-img')}</span>
                        <span><strong>${esc(item.title)}</strong><span>第 ${item.number} 集${
                        item.episodeTitle ? ` · ${esc(item.episodeTitle)}` : ''
                      }</span></span>
                        <span class="upcoming-badge">待播</span>
                      </button>`
                    )
                    .join('')}
                </div>`
              )
              .join('')
          : `<p class="rail-empty">未来一周没有已知的更新。Bangumi 提供播出日期之后，这里会自动排好。</p>`
      }
    </section>`;
}

/* ------------------------------------------------------------- library page */

function libraryCounts() {
  const counts = { all: state.items.length, unmatched: 0, none: 0, watching: 0, completed: 0 };
  for (const item of state.items) {
    if (item.match_state === 'unmatched') counts.unmatched += 1;
    else if (item.progress?.status === 'none') counts.none += 1;
    if (item.progress?.status === 'watching') counts.watching += 1;
    if (item.progress?.status === 'completed') counts.completed += 1;
  }
  return counts;
}

function typeCounts(items = state.items) {
  return {
    all: items.length,
    episode: items.filter((item) => item.media_kind === 'episode').length,
    movie: items.filter((item) => item.media_kind === 'movie').length,
    special: items.filter((item) => item.media_kind === 'special').length,
  };
}

function yearCounts() {
  const map = new Map();
  for (const item of state.items) {
    const year = item.air_date ? String(item.air_date).slice(0, 4) : null;
    if (!year) continue;
    map.set(year, (map.get(year) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function visibleLibraryItems() {
  const query = state.query.trim().toLowerCase();
  let items = state.items.filter((item) => {
    if (state.filter === 'unmatched') return item.match_state === 'unmatched';
    if (state.filter !== 'all' && item.progress?.status !== state.filter) return false;
    if (state.type !== 'all' && item.media_kind !== state.type) return false;
    if (state.year !== 'all' && String(item.air_date ?? '').slice(0, 4) !== state.year) return false;
    return true;
  });

  if (query) {
    items = items.filter((item) =>
      [item.title_cn, item.title_orig, item.source_folder]
        .filter(Boolean)
        .some((text) => String(text).toLowerCase().includes(query))
    );
  }

  const sorters = {
    recent: (a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')),
    rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
    title: (a, b) => String(a.title_cn ?? '').localeCompare(String(b.title_cn ?? ''), 'zh-Hans-CN'),
    progress: (a, b) => (b.progress?.percent ?? 0) - (a.progress?.percent ?? 0),
    files: (a, b) => (b.progress?.totalFiles ?? 0) - (a.progress?.totalFiles ?? 0),
  };
  return items.sort(sorters[state.sort] ?? sorters.recent);
}

const FILTER_LABEL = {
  all: '全部',
  none: '未看',
  watching: '观看中',
  completed: '已看完',
  unmatched: '待确认',
};

const TYPE_LABEL = { episode: 'TV 版', movie: '剧场版' };

function filterButton(id, label, count, iconName) {
  return `
    <button class="filter-item${state.filter === id ? ' is-active' : ''}" type="button" data-filter="${id}">
      <span class="filter-icon">${icon(iconName)}</span>
      <span class="filter-label">${label}</span>
      <span class="filter-count">${count}</span>
    </button>`;
}

function renderLibrary() {
  const page = $('page-library');
  if (!state.loaded) {
    page.innerHTML = loadingMarkup('正在载入媒体库…');
    return;
  }

  const counts = libraryCounts();
  const types = typeCounts();
  const years = yearCounts();
  if (state.year !== 'all' && !years.some(([year]) => year === state.year)) state.year = 'all';
  const items = visibleLibraryItems();
  const yearOptions = years
    .map(
      ([year, count]) =>
        `<option value="${year}"${state.year === year ? ' selected' : ''}>${year} 年 · ${count} 部</option>`
    )
    .join('');

  page.innerHTML = `
    <div class="library-page">
      <aside class="library-side">
        <div class="filter-panel">
          <div class="filter-group">
            <div class="filter-title">媒体库</div>
            ${filterButton('all', '全部', counts.all, 'library')}
            ${filterButton('none', '未看', counts.none, 'circle')}
            ${filterButton('watching', '观看中', counts.watching, 'play')}
            ${filterButton('completed', '已看完', counts.completed, 'check')}
          </div>
        </div>

        <div class="filter-panel filter-panel--filters">
          <div class="filter-group">
            <div class="filter-title">类型</div>
            ${[
              ['all', '全部类型', types.all],
              ['episode', 'TV 版', types.episode],
              ['movie', '剧场版', types.movie],
            ]
              .map(
                ([id, label, count]) => `
                <button class="filter-item filter-item--plain${state.type === id ? ' is-active' : ''}"
                  type="button" data-type="${id}">
                  <span class="filter-label">${label}</span><span class="filter-count">${count}</span>
                </button>`
              )
              .join('')}
          </div>

          <div class="filter-group">
            <div class="filter-title">年份</div>
            <label class="filter-select">
              <select id="yearSelect" aria-label="按年份筛选">
                <option value="all">全部年份</option>
                ${yearOptions}
              </select>
            </label>
          </div>
        </div>
      </aside>

      <section class="library-main">
        <header class="page-head page-head--row">
          <div>
            <span class="eyebrow">${icon('library')} 你的番剧库</span>
            <h1>媒体库</h1>
            <p>${counts.all} 部番剧 · ${counts.watching} 部在看</p>
          </div>
          <div class="page-actions">
            <div class="view-switch" role="group" aria-label="视图">
              <button class="${state.view === 'grid' ? 'is-active' : ''}" type="button" data-view="grid" title="海报墙" aria-label="海报墙">${icon('library')}</button>
              <button class="${state.view === 'list' ? 'is-active' : ''}" type="button" data-view="list" title="列表" aria-label="列表">${icon('list')}</button>
            </div>
            <label class="select-pill">
              <span>排序</span>
              <select id="sortSelect">
                <option value="recent"${state.sort === 'recent' ? ' selected' : ''}>添加时间</option>
                <option value="rating"${state.sort === 'rating' ? ' selected' : ''}>评分</option>
                <option value="title"${state.sort === 'title' ? ' selected' : ''}>名称</option>
                <option value="progress"${state.sort === 'progress' ? ' selected' : ''}>观看进度</option>
                <option value="files"${state.sort === 'files' ? ' selected' : ''}>文件数</option>
              </select>
            </label>
            <button class="btn btn-primary" type="button" data-scan data-scan-label="扫描媒体库">
              ${icon('refresh')}<span data-scan-label>扫描媒体库</span>
            </button>
          </div>
        </header>

        <div class="library-bar">
          <div class="library-summary">
            <strong>${FILTER_LABEL[state.filter] ?? '全部'}</strong>
            <span>${items.length} 部</span>
            ${state.type !== 'all' ? `<span class="query-chip">${TYPE_LABEL[state.type] ?? ''}</span>` : ''}
            ${state.year !== 'all' ? `<span class="query-chip">${esc(state.year)} 年</span>` : ''}
            ${state.query ? `<span class="query-chip">“${esc(state.query)}”<button type="button" data-clear-query aria-label="清空搜索">${icon('close')}</button></span>` : ''}
          </div>
          <div class="library-hint">${state.view === 'grid' ? '海报墙' : '列表'} · 点击卡片查看详情</div>
        </div>

        ${
          items.length
            ? `<div class="${state.view === 'grid' ? 'poster-grid' : 'media-list'}">
                ${items.map(state.view === 'grid' ? renderPosterCard : renderMediaRow).join('')}
              </div>`
            : emptyMarkup(
                'search',
                '没有符合条件的番剧',
                state.items.length ? '换个筛选条件或清空搜索试试。' : '媒体库还是空的，点右上角「扫描媒体库」开始整理。'
              )
        }
      </section>
    </div>`;

  $('sortSelect')?.addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderLibrary();
  });
  $('yearSelect')?.addEventListener('change', (event) => {
    state.year = event.target.value;
    renderLibrary();
  });
  renderScanStatus();
}

/* ----------------------------------------------------------- favourites page */

function renderFavorites() {
  const page = $('page-favorites');
  if (!state.loaded) {
    page.innerHTML = loadingMarkup('正在载入收藏…');
    return;
  }
  const favorites = state.items.filter((item) => item.favorite);
  const types = typeCounts(favorites);
  const shown = state.favType === 'all' ? favorites : favorites.filter((item) => item.media_kind === state.favType);

  page.innerHTML = `
    <div class="favorites-page">
      <header class="page-head">
        <div>
          <span class="eyebrow">${icon('heart')} 收藏</span>
          <h1>你收藏的番剧</h1>
          <p>${favorites.length} 部收藏 · 点海报右上角的爱心可以随时取消。</p>
        </div>
      </header>

      <div class="favorites-layout">
        <aside class="filter-panel filter-panel--compact">
          <div class="fav-total">
            <span class="fav-total-icon">${icon('heartSolid')}</span>
            <strong>${favorites.length}</strong>
            <span>全部收藏</span>
          </div>
          ${[
            ['all', '全部', types.all],
            ['episode', '番剧', types.episode],
            ['movie', '剧场版', types.movie],
            ['special', '特别篇', types.special],
          ]
            .map(
              ([id, label, count]) => `
              <button class="filter-item${state.favType === id ? ' is-active' : ''}" type="button" data-fav-type="${id}">
                <span class="filter-label">${label}</span><span class="filter-count">${count}</span>
              </button>`
            )
            .join('')}
          <div class="fav-hint">${icon('sparkles')}<span>收藏会保存在本机，重启后依然在。</span></div>
        </aside>

        <div class="favorites-main">
          ${
            shown.length
              ? `<div class="poster-grid">${shown.map(renderPosterCard).join('')}</div>`
              : emptyMarkup(
                  'heart',
                  favorites.length ? '这个分类还没有收藏' : '还没有收藏任何番剧',
                  favorites.length
                    ? '切换到「全部」，或者去媒体库逛逛。'
                    : '在任意海报或详情页点击爱心，就会出现在这里。',
                  `<button class="btn btn-primary" type="button" data-nav="library">${icon('library')}去媒体库看看</button>`
                )
          }
        </div>
      </div>
    </div>`;
}

/* -------------------------------------------------------------- settings page */

const SETTINGS_TABS = [
  { id: 'appearance', label: '外观', icon: 'image' },
  { id: 'library', label: '媒体库', icon: 'folder' },
  { id: 'match', label: '番剧识别', icon: 'sparkles' },
  { id: 'network', label: '网络', icon: 'globe' },
  { id: 'advanced', label: '高级', icon: 'sliders' },
];

function renderSettings() {
  const page = $('page-settings');
  if (!state.settings) {
    page.innerHTML = loadingMarkup('正在载入设置…');
    if (!state.settingsLoading) {
      state.settingsLoading = true;
      loadSettings();
    }
    return;
  }

  // Build the shell only once. Tab switches and live controls update the body
  // instead of replacing the whole page, which used to make the panel flash
  // and lose scroll position on every click.
  if (!$('settingsBody')) {
    page.innerHTML = `
      <div class="settings-page">
        <header class="page-head">
          <div>
            <span class="eyebrow">${icon('settings')} 设置</span>
            <h1>个性化你的媒体库</h1>
            <p>外观、扫描与匹配偏好都保存在本机。</p>
          </div>
        </header>

        <div class="settings-layout">
          <aside class="settings-nav">
            ${SETTINGS_TABS.map(
              (tab) => `
              <button class="settings-tab${state.settingsTab === tab.id ? ' is-active' : ''}" type="button"
                data-settings-tab="${tab.id}">
                <span class="settings-tab-icon">${icon(tab.icon)}</span><span>${tab.label}</span>
              </button>`
            ).join('')}
            <div class="settings-version">本地番剧媒体库 · v0.1.0</div>
          </aside>

          <div class="settings-body" id="settingsBody"></div>
        </div>
      </div>`;
  }

  renderSettingsBody();
}

function renderSettingsBody() {
  const body = $('settingsBody');
  if (!body) return;
  body.innerHTML = settingsPanelMarkup();
  bindSettings();
  renderScanStatus();
  refreshCacheInfo();
}

async function refreshCacheInfo() {
  const text = $('cacheText');
  if (!text || !window.desktopWindow?.cacheInfo) return;
  try {
    const info = await window.desktopWindow.cacheInfo();
    text.textContent = `当前缓存占用 ${info.text}（${info.path}）。清理后会在需要时自动重建。`;
  } catch (error) {
    text.textContent = `无法读取缓存大小：${error.message}`;
  }
}

function selectSettingsTab(tabId) {
  if (!SETTINGS_TABS.some((tab) => tab.id === tabId)) return;
  state.settingsTab = tabId;
  for (const button of document.querySelectorAll('[data-settings-tab]')) {
    button.classList.toggle('is-active', button.dataset.settingsTab === tabId);
  }
  renderSettingsBody();
}

function markThemeSelection() {
  for (const node of document.querySelectorAll('.theme-swatch')) {
    node.classList.toggle('is-active', node.dataset.themeId === state.theme?.id);
  }
}

function settingsPanelMarkup() {
  if (state.settingsTab === 'appearance') return appearancePanel();
  if (state.settingsTab === 'library') return librarySettingsPanel();
  if (state.settingsTab === 'match') return matchSettingsPanel();
  if (state.settingsTab === 'network') return networkSettingsPanel();
  return advancedPanel();
}

function appearancePanel() {
  const { blur, brightness, hasImage, url } = state.appearance;
  const featured = state.recent[0] ?? state.items[0];

  return `
    <div class="setting-panel">
      <div class="setting-panel-head">
        <h2>外观设置</h2>
        <p>主题色、Dock 位置与液态玻璃质感。</p>
      </div>

      <div class="setting-grid">
        <div class="setting-column">
          <section class="setting-group">
            <div class="setting-label">主题色</div>
            <div class="theme-swatches">
              ${THEMES.map(
                (theme) => `
                <button class="theme-swatch${state.theme?.id === theme.id ? ' is-active' : ''}" type="button"
                  data-theme-id="${theme.id}" title="${theme.label}"
                  style="--swatch-a:${theme.accent};--swatch-b:${theme.accent2}">
                  <i></i>
                </button>`
              ).join('')}
              <label class="theme-custom" title="自定义颜色">
                <input id="themeCustom" type="color" value="${state.theme?.accent ?? THEMES[0].accent}" />
                ${icon('plus')}
              </label>
            </div>
            <p class="setting-hint">只影响按钮、进度条与选中态，不改动海报本身。</p>
          </section>

          <section class="setting-group">
            <div class="setting-label">Dock 栏位置</div>
            <div class="segmented segmented--wide">
              ${[
                ['left', '左侧'],
                ['bottom', '底部'],
                ['right', '右侧'],
              ]
                .map(
                  ([id, label]) => `
                  <button class="seg-item${state.dock === id ? ' is-active' : ''}" type="button" data-dock-to="${id}">
                    ${label}
                  </button>`
                )
                .join('')}
            </div>
            <p class="setting-hint">悬浮 Dock 可以摆在窗口左侧、底部或右侧，立即生效。</p>
          </section>

          <section class="setting-group">
            <div class="setting-label">背景图</div>
            <div id="bgPreviewWrap">${
              hasImage ? `<div class="bg-current" id="bgCurrent"><img src="${esc(url)}" alt="" /></div>` : ''
            }</div>
            <div class="setting-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-setting="pick-bg">${icon('image')}上传图片</button>
              <button class="btn btn-ghost btn-sm" type="button" id="bgClear" data-setting="clear-bg" ${hasImage ? '' : 'disabled'}>${icon('trash')}清除背景</button>
            </div>
            <input id="bgFile" type="file" accept="image/*" hidden />
            <p class="setting-hint" id="bgHint">${
              hasImage ? '已设置自定义背景图，可调节模糊与亮度。' : '上传一张图片作为页面背景；不设置时使用内置极光渐变。'
            }</p>

            <div id="bgTuning"${hasImage ? '' : ' hidden'}>
              <div class="setting-row">
                <label class="setting-label" for="bgBlur">背景模糊</label>
                <span class="setting-value" id="bgBlurValue">${blur} px</span>
              </div>
              <input id="bgBlur" class="range" type="range" min="0" max="40" step="1" value="${blur}" />
              <div class="setting-row">
                <label class="setting-label" for="bgBright">背景亮度</label>
                <span class="setting-value" id="bgBrightValue">${Math.round(brightness * 100)}%</span>
              </div>
              <input id="bgBright" class="range" type="range" min="30" max="150" step="1" value="${Math.round(brightness * 100)}" />
            </div>
          </section>

          <section class="setting-group">
            <div class="setting-row">
              <label class="setting-label" for="glassRange">液态玻璃</label>
              <span class="setting-value" id="glassValue">${state.glass} px</span>
            </div>
            <input id="glassRange" class="range" type="range" min="0" max="48" step="2" value="${state.glass}" />
            <div class="glass-scale"><span>通透</span><span>朦胧</span></div>
            <p class="setting-hint">调节所有玻璃面板的模糊强度；值越大，液态玻璃越朦胧。</p>
          </section>
        </div>

        <aside class="preview-column">
          <div class="preview-card">
            <div class="preview-topbar">
              <span class="preview-brand"><img src="/icon.jpg" alt="" />本地番剧媒体库</span>
              <span class="preview-search"></span>
              <span class="preview-dots">···</span>
            </div>
            <div class="preview-body">
              <div class="preview-poster">${featured ? coverMarkup(featured, 'preview-img') : ''}
                <span class="preview-badge">${featured?.progress ? `${Math.round(featured.progress.percent * 100)}%` : 'NEW'}</span>
              </div>
              <div class="preview-meta">
                <strong>${esc(featured?.title_cn ?? featured?.title ?? '葬送的芙莉莲')}</strong>
                <span>第 17 集 · 12:32</span>
                <span class="progress-track"><i style="width:63%"></i></span>
              </div>
            </div>
            <div class="preview-copy">
              <strong>沉浸式的番剧体验</strong>
              <span>让你的番剧库更加美好</span>
            </div>
            <div class="preview-dock">
              ${PAGES.map(
                (page) => `<span class="${page.id === 'settings' ? 'is-active' : ''}">${icon(page.icon)}</span>`
              ).join('')}
            </div>
          </div>
          <p class="preview-hint">预览会跟随主题色与玻璃强度变化；背景图只保存在本机。</p>
        </aside>
      </div>
    </div>`;
}

function librarySettingsPanel() {
  const settings = state.settings;
  return `
    <div class="setting-panel">
      <div class="setting-panel-head"><h2>媒体库</h2><p>程序只读扫描，不会移动、重命名或删除任何文件。</p></div>
      <section class="setting-group">
        <label class="setting-label" for="setDirs">扫描目录（每行一个）</label>
        <textarea id="setDirs" class="text-input text-area" rows="4">${esc((settings.scanDirs ?? []).join('\n'))}</textarea>
        <div class="setting-hint">当前库中 ${state.items.length} 部番剧。${scanChipMarkup()}</div>
        <div class="setting-actions">
          <button class="btn btn-primary" type="button" data-setting="save-library">保存目录</button>
          <button class="btn btn-ghost" type="button" data-scan data-scan-label="立即扫描">${icon('refresh')}<span data-scan-label>立即扫描</span></button>
        </div>
      </section>
      <section class="setting-group">
        <div class="setting-label">数据库</div>
        <div class="info-grid">
          <div><span>番剧</span><strong>${state.items.length}</strong></div>
          <div><span>在看</span><strong>${state.stats.watching ?? 0}</strong></div>
          <div><span>已看完</span><strong>${state.stats.completed ?? 0}</strong></div>
          <div><span>待确认</span><strong>${state.stats.unmatched ?? 0}</strong></div>
        </div>
        <p class="setting-hint">数据库与封面缓存在本机数据目录，断网也能浏览。</p>
      </section>
    </div>`;
}

function matchSettingsPanel() {
  const settings = state.settings;
  return `
    <div class="setting-panel">
      <div class="setting-panel-head"><h2>番剧识别</h2><p>自动匹配越保守，需要手动确认的番剧越多。</p></div>
      <section class="setting-group">
        <div class="setting-row"><label class="setting-label" for="setThreshold">自动匹配阈值</label>
          <span class="setting-value">${Number(settings.matchThreshold).toFixed(2)}</span></div>
        <input id="setThreshold" class="range" type="range" min="0.3" max="0.95" step="0.01" value="${settings.matchThreshold}" />
        <p class="setting-hint">调高更保守（宁可让你手动确认），调低更容易自动绑定。</p>
      </section>
      <section class="setting-group">
        <div class="setting-row"><label class="setting-label" for="setMargin">领先优势</label>
          <span class="setting-value">${Number(settings.matchMargin).toFixed(2)}</span></div>
        <input id="setMargin" class="range" type="range" min="0" max="0.5" step="0.01" value="${settings.matchMargin}" />
        <p class="setting-hint">第一名必须比第二名高出这么多分才会自动绑定，避免在相似条目之间乱猜。</p>
      </section>
      <div class="setting-actions">
        <button class="btn btn-primary" type="button" data-setting="save-match">保存识别设置</button>
      </div>
    </div>`;
}

function networkSettingsPanel() {
  const settings = state.settings;
  return `
    <div class="setting-panel">
      <div class="setting-panel-head"><h2>网络</h2><p>访问 Bangumi 抓取元数据时使用的代理。</p></div>
      <section class="setting-group">
        <label class="setting-label" for="setProxy">网络代理</label>
        <input id="setProxy" class="text-input" type="text" value="${esc(settings.proxy ?? 'auto')}" placeholder="auto / 留空 / http://127.0.0.1:7890" />
        <p class="setting-hint">
          <code>auto</code> = 自动探测；留空 = 直连；也可写死端口。当前实际使用：<code>${esc(
            settings.resolvedProxy ?? '直连'
          )}</code>
        </p>
      </section>
      <div class="setting-actions">
        <button class="btn btn-primary" type="button" data-setting="save-network">保存网络设置</button>
      </div>
      <p class="setting-hint">代理改动需要重启程序才会完全生效。</p>
    </div>`;
}

function advancedPanel() {
  return `
    <div class="setting-panel">
      <div class="setting-panel-head"><h2>高级</h2><p>恢复默认外观，或者查看本地数据说明。</p></div>
      <section class="setting-group">
        <div class="setting-label">外观偏好</div>
        <p class="setting-hint">会把主题色、深色 / 亮色、Dock 位置和玻璃强度恢复为默认值。</p>
        <div class="setting-actions">
          <button class="btn btn-ghost" type="button" data-setting="reset-prefs">恢复默认外观</button>
        </div>
      </section>
      <section class="setting-group">
        <div class="setting-label">桌面版缓存</div>
        ${
          window.desktopWindow?.cacheInfo
            ? `<p class="setting-hint" id="cacheText">正在读取缓存大小…</p>
               <div class="setting-actions">
                 <button class="btn btn-ghost" type="button" data-setting="clear-cache" id="cacheClear">清理缓存</button>
               </div>`
            : '<p class="setting-hint">浏览器版不产生桌面缓存，无需清理。</p>'
        }
        <p class="setting-hint">只清理 Chromium 的 Cache / GPUCache 等派生文件，不会动番剧库、封面、观看记录和设置。</p>
      </section>
      <section class="setting-group">
        <div class="setting-label">快捷键</div>
        <div class="shortcut-list">
          <div><span>聚焦搜索</span><kbd>/</kbd></div>
          <div><span>关闭详情 / 对话框</span><kbd>Esc</kbd></div>
          <div><span>播放选中的剧集</span><kbd>双击</kbd></div>
        </div>
      </section>
      <section class="setting-group">
        <div class="setting-label">关于</div>
        <p class="setting-hint">本地番剧媒体库 v0.1.0 · 只读扫描 · 数据保存在本机。</p>
      </section>
    </div>`;
}

function bindSettings() {
  const themeCustom = $('themeCustom');
  if (themeCustom) {
    themeCustom.addEventListener('input', (event) => {
      // Live preview only: rebuilding the panel would close the picker.
      setTheme({ id: 'custom', label: '自定义', accent: event.target.value, accent2: event.target.value });
      markThemeSelection();
    });
    themeCustom.addEventListener('change', (event) => {
      setTheme({ id: 'custom', label: '自定义', accent: event.target.value, accent2: event.target.value }, { persist: true });
      markThemeSelection();
    });
  }

  const glass = $('glassRange');
  if (glass) {
    glass.addEventListener('input', () => {
      applyGlass(Number(glass.value));
      const label = $('glassValue');
      if (label) label.textContent = `${glass.value} px`;
    });
    glass.addEventListener('change', () => applyGlass(Number(glass.value), { persist: true }));
  }

  const blur = $('bgBlur');
  const bright = $('bgBright');
  if (blur) {
    blur.addEventListener('input', () => {
      const value = Number(blur.value);
      applyAppearance({ ...state.appearance, blur: value });
      $('bgBlurValue').textContent = `${value} px`;
    });
    blur.addEventListener('change', () => saveBackground({ blur: Number(blur.value) }));
  }
  if (bright) {
    bright.addEventListener('input', () => {
      const value = Number(bright.value);
      applyAppearance({ ...state.appearance, brightness: value / 100 });
      $('bgBrightValue').textContent = `${value}%`;
    });
    bright.addEventListener('change', () => saveBackground({ brightness: Number(bright.value) / 100 }));
  }

  const file = $('bgFile');
  file?.addEventListener('change', async (event) => {
    const picked = event.target.files?.[0];
    if (!picked) return;
    try {
      const image = await prepareBackgroundImage(picked);
      await saveBackground({ image });
    } catch (error) {
      toast(error.message, true);
    } finally {
      event.target.value = '';
    }
  });
}

/** Updates the background card in place, without rebuilding the settings page. */
function syncBackgroundControls() {
  const { hasImage, url, blur, brightness } = state.appearance;
  const wrap = $('bgPreviewWrap');
  if (wrap) {
    wrap.innerHTML = hasImage ? `<div class="bg-current" id="bgCurrent"><img src="${esc(url)}" alt="" /></div>` : '';
  }
  const tuning = $('bgTuning');
  if (tuning) tuning.hidden = !hasImage;
  const clear = $('bgClear');
  if (clear) clear.disabled = !hasImage;
  const hint = $('bgHint');
  if (hint) {
    hint.textContent = hasImage
      ? '已设置自定义背景图，可调节模糊与亮度。'
      : '上传一张图片作为页面背景；不设置时使用内置极光渐变。';
  }
  const blurValue = $('bgBlurValue');
  if (blurValue) blurValue.textContent = `${blur} px`;
  const brightValue = $('bgBrightValue');
  if (brightValue) brightValue.textContent = `${Math.round(brightness * 100)}%`;
}

async function saveBackground(patch) {
  try {
    const result = await api('/api/appearance', { method: 'POST', body: patch });
    applyAppearance(result);
    if (state.page === 'settings') syncBackgroundControls();
    toast('背景已更新');
  } catch (error) {
    toast(`背景设置失败：${error.message}`, true);
    applyAppearance(state.appearance);
    if (state.page === 'settings') syncBackgroundControls();
  }
}

async function loadSettings() {
  try {
    const [settings, appearance] = await Promise.all([api('/api/settings'), api('/api/appearance')]);
    state.settings = settings;
    applyAppearance(appearance);
    if (state.page === 'settings') renderSettings();
  } catch (error) {
    $('page-settings').innerHTML = emptyMarkup('alert', '设置载入失败', error.message);
  } finally {
    state.settingsLoading = false;
  }
}

/* ----------------------------------------------------------------- detail */

async function openDetail(seriesId) {
  state.matchSeriesId = null;
  openOverlay('<div class="loading-panel"><span class="spinner"></span> 正在载入…</div>');
  state.detailTab = null;
  state.detailGroups = null;
  try {
    const data = await api(`/api/series/${seriesId}`);
    state.detail = data;
    renderDetail();
  } catch (error) {
    overlayPanel.innerHTML = `<div class="loading-panel">载入失败：${esc(error.message)}</div>`;
  }
}

function tagsFor(series, counts) {
  const tags = [];
  if (series.air_date) tags.push(`播出 ${series.air_date}`);
  if (series.rating) tags.push(`★ ${series.rating.toFixed(1)}${series.rating_count ? ` (${series.rating_count} 人)` : ''}`);
  if (series.eps_total) tags.push(`Bangumi ${series.eps_total} 集`);
  tags.push(`本地 ${counts.episodes} 集`);
  if (counts.specials) tags.push(`特别篇 ${counts.specials}`);
  if (counts.movies) tags.push(`剧场版 ${counts.movies}`);
  if (series.season) tags.push(`第 ${series.season} 季`);
  if (series.match_state === 'manual') tags.push('手动绑定');
  if (series.match_state === 'unmatched') tags.push('未识别');
  return tags;
}

const DETAIL_TABS = [
  { id: 'episodes', label: '正片' },
  { id: 'specials', label: '特别篇' },
  { id: 'movies', label: '剧场版' },
  { id: 'missing', label: '未收录' },
];

function renderDetail() {
  const { series, progress, episodes, missing, extras, counts, sourceFolder } = state.detail;
  overlayPanel.classList.remove('narrow', 'dialog-panel');
  overlayPanel.classList.add('detail-panel');

  state.detailGroups = {
    episodes,
    specials: extras.filter((item) => item.kind === 'special'),
    movies: extras.filter((item) => item.kind === 'movie'),
    missing,
  };

  let tabs = DETAIL_TABS.map((tab) => ({ ...tab, count: state.detailGroups[tab.id].length })).filter(
    (tab) => tab.count > 0
  );
  if (tabs.length === 0) tabs = [{ ...DETAIL_TABS[0], count: 0 }];
  if (!state.detailTab || !tabs.some((tab) => tab.id === state.detailTab)) state.detailTab = tabs[0].id;

  const tags = tagsFor(series, counts);
  const mapping = state.detail.mapping ?? { offset: 0, auto: true, matched: 0, localTotal: 0 };
  const mappingText =
    mapping.offset === 0
      ? '本地集号与 Bangumi 一致'
      : `本地 ${mapping.localMin ?? '?'} 集 → Bangumi 第 ${(mapping.localMin ?? 0) + mapping.offset} 集`;
  const mappingMeta = series.bangumi_id
    ? `${mapping.matched}/${mapping.localTotal} 集对得上 · ${mapping.auto ? '自动推断' : '手动指定'}`
    : '尚未匹配 Bangumi';
  const bangumiLink = series.bangumi_id
    ? `<a class="action-menu-item" href="https://bgm.tv/subject/${series.bangumi_id}" target="_blank" rel="noreferrer">
        ${icon('globe')}在 Bangumi 打开
      </a>`
    : '';

  overlayPanel.innerHTML = `
    <div class="detail">
      <header class="detail-head">
        <button class="round-btn" type="button" data-action="close" title="返回（Esc）" aria-label="返回">${icon('chevronLeft')}</button>
        <div class="detail-head-title">
          <strong>${esc(series.title_cn ?? '未命名')}</strong>
          <span>${esc(sourceFolder ?? '')}</span>
        </div>
        <div class="detail-head-actions">
          <button class="btn btn-ghost btn-sm detail-fav${series.favorite ? ' is-fav' : ''}" type="button" data-action="favorite">
            ${icon(series.favorite ? 'heartSolid' : 'heart')}<span>${series.favorite ? '已收藏' : '收藏'}</span>
          </button>
          <button class="btn btn-primary btn-sm" type="button" data-action="watch-all">${icon('check')}全部已看</button>
          <div class="head-more">
            <button class="icon-btn" type="button" data-action="detail-more" aria-haspopup="menu" aria-expanded="false" title="更多操作" aria-label="更多操作">${icon('menu')}</button>
            <div class="action-menu" id="detailMenu" role="menu" hidden>
              <button class="action-menu-item" type="button" data-action="unwatch-all" role="menuitem">${icon('circle')}全部标为未看</button>
              <button class="action-menu-item" type="button" data-action="reveal-series" role="menuitem">${icon('folder')}打开文件夹</button>
              <button class="action-menu-item" type="button" data-action="rematch" role="menuitem">${icon('refresh')}重新匹配…</button>
              <div class="action-menu-sep"></div>
              ${bangumiLink}
            </div>
          </div>
        </div>
      </header>

      <div class="detail-body">
        <aside class="detail-aside">
          <div class="detail-cover">${coverMarkup(series, 'detail-img')}</div>
          <h2 class="detail-title">${esc(series.title_cn ?? '未命名')}</h2>
          ${series.title_orig ? `<div class="detail-orig">${esc(series.title_orig)}</div>` : ''}
          <div class="tag-row">${tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div>

          <div class="detail-progress">
            <div class="detail-progress-head">
              <span>${STATUS_LABEL[progress.status]} · ${progress.watched}/${progress.total || progress.localTotal} 集</span>
              <strong class="progress-percent">${Math.round(progress.percent * 100)}%</strong>
            </div>
            <span class="track"><i style="width:${Math.round(progress.percent * 100)}%"></i></span>
          </div>

          ${series.summary ? `<p class="detail-summary">${esc(series.summary)}</p>` : ''}

          <div class="source-block">
            <div class="source-label">集号对应</div>
            ${
              series.bangumi_id
                ? `<div class="mapping-value">${esc(mappingText)}</div>
                   <div class="source-meta">${esc(mappingMeta)}（在「重新匹配」里调整）</div>`
                : '<div class="source-meta">匹配到 Bangumi 之后才能计算集号对应关系。</div>'
            }
          </div>
          <div class="source-block">
            <div class="source-label">来源</div>
            <code>${esc(sourceFolder ?? '')}</code>
            <div class="source-meta">共 ${counts.files} 个视频文件${
              counts.missingEpisodes ? ` · Bangumi 上还有 ${counts.missingEpisodes} 集本地没有` : ''
            }</div>
          </div>
        </aside>

        <section class="detail-episodes">
          <div class="tabs">
            ${tabs
              .map(
                (tab) =>
                  `<button class="tab${tab.id === state.detailTab ? ' is-active' : ''}" type="button" data-action="tab" data-tab="${tab.id}">
                    ${tab.label}<span class="tab-count">${tab.count}</span>
                  </button>`
              )
              .join('')}
          </div>
          <div class="ep-scroll" id="epPane">${episodePaneContent()}</div>
        </section>
      </div>
    </div>`;
}

function episodePaneContent() {
  const list = state.detailGroups?.[state.detailTab] ?? [];
  if (list.length === 0) {
    return `<div class="pane-empty">${state.detailTab === 'episodes' ? '没有识别到正片文件' : '这里还没有内容'}</div>`;
  }
  if (state.detailTab === 'specials' || state.detailTab === 'movies') return list.map(renderExtraRow).join('');
  return list.map(renderEpisodeRow).join('');
}

function findFileById(fileId) {
  const id = Number(fileId);
  const groups = state.detail ? [state.detail.episodes, state.detail.missing, state.detail.extras] : [];
  for (const group of groups) {
    for (const item of group ?? []) {
      const file = (item.files ?? []).find((entry) => entry.id === id);
      if (file) return { file, item };
    }
  }
  return null;
}

function openFileInfo(fileId) {
  const found = findFileById(fileId);
  if (!found) return;
  const { file, item } = found;
  const meta = parseFileMeta(file);
  const episodeLabel =
    item.number != null ? `第 ${item.number} 集` : item.kind === 'movie' ? '剧场版' : '特别篇';
  const rows = [
    ['文件', file.name],
    ['容器', meta.container],
    ['视频', meta.video],
    ['音频', meta.audio],
    ['字幕', meta.subtitle],
    ['大小', formatSize(file.size)],
    ['路径', file.path],
  ];

  filePanel.innerHTML = `
    <div class="dialog file-dialog">
      <header class="dialog-head">
        <h3>文件信息</h3>
        <button class="btn btn-ghost btn-sm" type="button" data-action="file-close">关闭</button>
      </header>
      <div class="dialog-body">
        <div class="file-summary">
          <span class="file-summary-ep">${esc(episodeLabel)}</span>
          <strong>${esc(item.title || file.name)}</strong>
          <span class="file-summary-compact">${esc(meta.compact || formatSize(file.size))}</span>
        </div>
        <dl class="file-rows">
          ${rows
            .map(
              ([label, value]) =>
                `<div class="file-row"><dt>${label}</dt><dd>${esc(value || '—')}</dd></div>`
            )
            .join('')}
        </dl>
      </div>
      <footer class="dialog-foot">
        <button class="btn btn-ghost" type="button" data-action="reveal-folder">${icon('folder')}打开文件夹</button>
        <button class="btn btn-primary" type="button" data-action="play" data-file="${file.id}">${icon('play')}播放</button>
      </footer>
    </div>`;
  fileOverlay.hidden = false;
}

function closeFileInfo() {
  fileOverlay.hidden = true;
  filePanel.innerHTML = '';
}

async function revealSeriesFolder() {
  if (!state.detail) return;
  try {
    await api(`/api/series/${state.detail.series.id}/reveal`, { method: 'POST' });
    toast('已在文件管理器中打开番剧文件夹');
  } catch (error) {
    toast(`无法打开文件夹：${error.message}`, true);
  }
}

function selectTab(tabId) {
  state.detailTab = tabId;
  for (const node of overlayPanel.querySelectorAll('.tab')) {
    node.classList.toggle('is-active', node.dataset.tab === tabId);
  }
  const pane = $('epPane');
  if (pane) pane.innerHTML = episodePaneContent();
}

function updateProgressUi() {
  const progress = state.detail?.progress;
  if (!progress) return;
  const percent = Math.round(progress.percent * 100);
  const line = overlayPanel.querySelector('.detail-progress-head > span');
  const percentNode = overlayPanel.querySelector('.progress-percent');
  const bar = overlayPanel.querySelector('.detail-progress .track > i');
  if (line) line.textContent = `${STATUS_LABEL[progress.status]} · ${progress.watched}/${progress.total || progress.localTotal} 集`;
  if (percentNode) percentNode.textContent = `${percent}%`;
  if (bar) bar.style.width = `${percent}%`;
}

function renderEpisodeRow(episode) {
  const shifted = episode.bangumiNumber != null && episode.bangumiNumber !== episode.number;
  const label = shifted ? `本地 ${episode.number} 集 · BGM ${episode.bangumiNumber}` : `第 ${episode.number} 集`;
  const playButtons = (episode.files ?? [])
    .map(
      (file) =>
        `<button class="btn btn-ghost btn-sm" type="button" data-action="play" data-file="${file.id}" title="${esc(
          file.path
        )}">${icon('play')} 播放</button>`
    )
    .join('');
  const first = episode.files?.[0];
  const meta = first ? parseFileMeta(first) : null;
  const fileHint = first
    ? `<button class="file-meta" type="button" data-file-info="${first.id}" title="${esc(first.name)}">
        <span>${esc(meta.compact || first.name)}</span>
        ${episode.files.length > 1 ? `<span class="file-count">+${episode.files.length - 1}</span>` : ''}
        <span class="file-meta-more">${icon('chevronRight')}</span>
      </button>`
    : '';
  const titleText = episode.title
    ? esc(episode.title)
    : episode.inLibrary
      ? '<span class="muted">（本地特有集，Bangumi 正片列表未收录）</span>'
      : '<span class="muted">（Bangumi 未提供这一集的标题）</span>';

  return `
    <div class="ep-row ${episode.watched ? 'is-watched' : ''}" data-item-key="${esc(episode.itemKey)}"
      data-file-id="${episode.files?.[0]?.id ?? ''}"${episode.files?.[0] ? ' title="双击用系统默认播放器打开"' : ''}>
      <button class="ep-check" type="button" data-action="toggle" title="标记已看 / 未看" aria-label="标记已看 / 未看">${icon('check')}</button>
      <span class="ep-number">${esc(label)}</span>
      <span class="ep-main">
        <span class="ep-title" title="${esc(episode.title ?? '')}">${titleText}${
          episode.inLibrary ? '' : ' <span class="muted">· 本地缺</span>'
        }</span>
        ${fileHint}
      </span>
      <span class="ep-actions">${playButtons}</span>
    </div>`;
}

function renderExtraRow(extra) {
  const file = extra.files?.[0];
  const short = file
    ? extra.kind === 'movie'
      ? fileTitleHint(file.name) || extraLabel(file.name)
      : extraLabel(file.name)
    : extra.title;
  const number = file?.epLabel ? `#${file.epLabel} ` : '';
  const meta = file ? parseFileMeta(file) : null;
  return `
    <div class="ep-row ${extra.watched ? 'is-watched' : ''}" data-item-key="${esc(extra.itemKey)}"
      data-file-id="${file?.id ?? ''}"${file?.id ? ' title="双击用系统默认播放器打开"' : ''}>
      <button class="ep-check" type="button" data-action="toggle" title="标记已看 / 未看" aria-label="标记已看 / 未看">${icon('check')}</button>
      <span class="ep-number">${extra.kind === 'movie' ? '剧场版' : '特别篇'}</span>
      <span class="ep-main">
        <span class="ep-title" title="${esc(short)}">${number}${esc(short)}</span>
        ${
          file
            ? `<button class="file-meta" type="button" data-file-info="${file.id}" title="${esc(file.name)}">
                <span>${esc(meta.compact || file.name)}</span>
                <span class="file-meta-more">${icon('chevronRight')}</span>
              </button>`
            : ''
        }
      </span>
      <span class="ep-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-action="play" data-file="${file?.id}">${icon('play')} 播放</button>
      </span>
    </div>`;
}

const RELEASE_NOISE = /raws|fansub|kissaten|house|studio|\bsub\b|sub$|字幕组|压制/i;
const METADATA_TAG =
  /\b(?:1080|720|2160|1440|480|576)p\b|\b(?:x|h)26[45]\b|HEVC|AVC|AAC|FLAC|EAC3|AC3|DTS|\d+bit|BDRip|WebRip|TVRip|UHDRip|DVDRip|\b(?:CHS|CHT|GB|BIG5|JPSC|JPTC|JPN|SC|TC)\b|\b(?:MKV|MP4|AVI)\b|\bFin\b/i;

const labelKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

function fileTitleHint(fileName) {
  const outside = String(fileName ?? '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[[【][^\][【】]*[\]】]/g, ' ')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/[-–—_]\s*\d{1,4}(?:v\d)?\s*$/, ' ')
    .replace(/\b\d{1,4}(?:v\d)?\s*$/, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return outside.length >= 2 ? outside : '';
}

function extraLabel(fileName) {
  const { series } = state.detail ?? {};
  const base = String(fileName ?? '').replace(/\.[a-z0-9]{2,5}$/i, '');
  const tags = [...base.matchAll(/[[【]([^\][【】]*)[\]】]/g)].map((match) => match[1].trim()).filter(Boolean);
  const titleKeys = [series?.title_cn, series?.title_orig, series?.source_folder]
    .filter(Boolean)
    .map(labelKey)
    .filter(Boolean);

  const keep = tags.filter((tag) => {
    if (METADATA_TAG.test(tag)) return false;
    if (/^\d{1,4}(?:\.\d+)?$/.test(tag)) return false;
    const key = labelKey(tag);
    if (!key) return false;
    if (titleKeys.some((title) => title.includes(key) || key.includes(title))) return false;
    if (RELEASE_NOISE.test(tag)) return false;
    return true;
  });

  if (keep.length > 0) return keep.join(' · ');
  return base;
}

/* ------------------------------------------------------------ match dialog */

async function openMatchDialog() {
  const { series } = state.detail;

  const searchHints = (() => {
    const { episodes = [], extras = [] } = state.detail ?? {};
    const seen = new Set([series?.source_folder, series?.title_cn, series?.title_orig].map(labelKey).filter(Boolean));
    const hints = [];
    for (const item of [...episodes, ...extras]) {
      for (const file of item.files ?? []) {
        const hint = fileTitleHint(file.name);
        const key = labelKey(hint);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hints.push(hint);
        if (hints.length >= 4) return hints;
      }
    }
    return hints;
  })();

  const currentId = series.bangumi_id ?? null;
  const currentCandidate = currentId
    ? {
        bangumiId: currentId,
        title: series.title_cn,
        original: series.title_orig,
        date: series.air_date,
        eps: series.eps_total,
        cover: series.coverUrl,
        current: true,
      }
    : null;

  state.matchResults = currentCandidate ? [currentCandidate] : [];
  state.pendingCandidate = currentId;
  state.matchSeriesId = series.id;

  openOverlay(
    `<div class="dialog match-dialog">
      <header class="match-head">
        <div class="match-head-main">
          <span class="eyebrow">编辑匹配</span>
          <h3>${esc(series.title_cn ?? '未命名')}</h3>
          <p>${esc(series.source_folder ?? '')}</p>
        </div>
        <button class="round-btn" type="button" data-action="match-close" title="返回详情" aria-label="返回详情">${icon('chevronLeft')}</button>
      </header>

      <div class="match-body">
        <section class="match-left">
          <div class="match-search">
            <span class="match-search-icon">${icon('search')}</span>
            <input id="matchQuery" type="text" value="${esc(series.source_folder ?? '')}"
              placeholder="搜索中文名、日文原名或罗马音…" autocomplete="off" spellcheck="false" />
            <button class="btn btn-primary btn-sm" type="button" id="matchGo">搜索</button>
          </div>
          <p class="match-hint">列表里标着「当前」的是现在绑定的条目。</p>
          ${
            searchHints.length
              ? `<div class="match-hint-chips" id="matchHints">
                  <span>文件名里的标题</span>
                  ${searchHints
                    .map((hint) => `<button class="chip-btn" type="button" data-hint="${esc(hint)}">${esc(hint)}</button>`)
                    .join('')}
                </div>`
              : ''
          }
          <div class="match-result-head"><span>搜索结果</span><span id="matchCount"></span></div>
          <div class="candidate-list" id="candidateList"><div class="loading-panel"><span class="spinner"></span> 搜索中…</div></div>
        </section>

        <aside class="match-right">
          <div class="match-section">
            <div class="match-section-title">当前选择</div>
            <div id="matchSelected"></div>
          </div>

          <div class="match-section">
            <div class="match-section-title">集号对应</div>
            <label class="check-row"><input type="checkbox" id="mapAuto" ${
              state.detail.mapping?.auto !== false ? 'checked' : ''
            } /> 自动推断集号</label>
            <div class="mapping-grid">
              <label>本地第 <input id="mapLocal" class="text-input" type="number" step="1" value="${
                state.detail.mapping?.localMin ?? 1
              }" /></label>
              <span class="mapping-equals">=</span>
              <label>Bangumi 第 <input id="mapBgm" class="text-input" type="number" step="1" value="${
                (state.detail.mapping?.localMin ?? 1) + (state.detail.mapping?.offset ?? 0)
              }" /></label>
            </div>
            <p class="field-hint" id="mapPreview"></p>
          </div>
          <p class="match-note">应用后会按 Bangumi 的剧集列表重新同步；已有的观看记录不会丢失。</p>
        </aside>
      </div>

      <footer class="match-foot">
        <span class="match-foot-hint" id="matchFooterHint"></span>
        <div class="match-foot-actions">
          <button class="btn btn-ghost" type="button" data-action="match-close">取消</button>
          <button class="btn btn-primary" type="button" id="btnBind" disabled>应用更改</button>
        </div>
      </footer>
    </div>`,
    { match: true }
  );

  const input = $('matchQuery');
  const applyButton = $('btnBind');

  const renderSelection = () => {
    const selected = state.matchResults?.find((item) => item.bangumiId === state.pendingCandidate) ?? null;
    const target = $('matchSelected');
    if (!target) return;
    if (!selected) {
      target.innerHTML = `<div class="match-selected-empty">${icon('search')}<span>先搜索并选择一个条目</span></div>`;
      $('matchFooterHint').textContent = '';
      applyButton.disabled = true;
      return;
    }
    const isCurrent = selected.bangumiId === currentId;
    const cover = selected.cover
      ? `<img src="${esc(selected.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="cover-fallback" style="${posterFallback(selected.title ?? '')}">${esc(
          firstChar(selected.title)
        )}</span>`;
    target.innerHTML = `
      <div class="match-selected-card">
        <div class="match-selected-cover">${cover}</div>
        <div class="match-selected-main">
          <span class="badge ${isCurrent ? 'badge-ok' : 'badge-live'}">${isCurrent ? '当前绑定' : '将绑定'}</span>
          <strong>${esc(selected.title ?? '')}</strong>
          <span>${esc(selected.original ?? '')}</span>
          <span>${selected.date ?? '播出日期未知'}${selected.eps ? ` · ${selected.eps} 集` : ''}</span>
        </div>
      </div>`;
    $('matchFooterHint').textContent = isCurrent
      ? `当前绑定：${selected.title ?? ''}`
      : `将绑定：${selected.title ?? ''}`;
    applyButton.disabled = false;
  };

  const renderCandidateList = () => {
    const list = $('candidateList');
    const candidates = state.matchResults ?? [];
    $('matchCount').textContent = `${candidates.length} 个候选`;
    if (!candidates.length) {
      list.innerHTML = `<div class="candidate-empty">${icon('search')}<span>没有搜索结果。换个关键词再试。</span></div>`;
      return;
    }
    list.innerHTML = candidates
      .map((candidate) => {
        const selected = candidate.bangumiId === state.pendingCandidate;
        const cover = candidate.cover
          ? `<img src="${esc(candidate.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
          : `<span class="cover-fallback" style="${posterFallback(candidate.title ?? '')}">${esc(
              firstChar(candidate.title)
            )}</span>`;
        return `
          <button class="candidate-card${selected ? ' is-selected' : ''}" type="button" data-id="${candidate.bangumiId}">
            <span class="candidate-cover">${cover}</span>
            <span class="candidate-main">
              <span class="candidate-title">${esc(candidate.title ?? '')}${
                candidate.current ? '<span class="current-badge">当前</span>' : ''
              }</span>
              <span class="candidate-orig">${esc(candidate.original ?? '')}</span>
              <span class="candidate-meta">${candidate.date ?? '播出日期未知'}${
                candidate.eps ? ` · ${candidate.eps} 集` : ''
              }</span>
            </span>
            <span class="candidate-tail">
              ${candidate.score != null ? `<span class="score-pill">${Math.round(candidate.score * 100)}%</span>` : ''}
              ${selected ? `<span class="candidate-check">${icon('check')}</span>` : ''}
            </span>
          </button>`;
      })
      .join('');
  };

  const runSearch = async (keyword) => {
    $('candidateList').innerHTML = '<div class="loading-panel"><span class="spinner"></span> 搜索中…</div>';
    $('matchCount').textContent = '';
    try {
      const data = keyword
        ? await api(`/api/search?q=${encodeURIComponent(keyword)}`)
        : await api(`/api/series/${series.id}/candidates`);
      const results = data.candidates ?? [];
      state.matchResults = currentCandidate
        ? [currentCandidate, ...results.filter((item) => item.bangumiId !== currentId)]
        : results;
      state.pendingCandidate = currentId;
      renderCandidateList();
      renderSelection();
    } catch (error) {
      $('candidateList').innerHTML = `<div class="candidate-empty">${icon('alert')}<span>搜索失败：${esc(
        error.message
      )}</span></div>`;
    }
  };

  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(input.value.trim()), 450);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      clearTimeout(debounce);
      runSearch(input.value.trim());
    }
  });
  $('matchGo').addEventListener('click', () => {
    clearTimeout(debounce);
    runSearch(input.value.trim());
  });
  $('matchHints')?.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-hint]');
    if (!chip) return;
    clearTimeout(debounce);
    input.value = chip.dataset.hint;
    runSearch(chip.dataset.hint);
  });
  $('candidateList').addEventListener('click', (event) => {
    const card = event.target.closest('.candidate-card');
    if (!card) return;
    state.pendingCandidate = Number(card.dataset.id);
    const list = $('candidateList');
    const scrollTop = list.scrollTop;
    renderCandidateList();
    list.scrollTop = scrollTop;
    renderSelection();
  });

  const auto = $('mapAuto');
  const localInput = $('mapLocal');
  const bgmInput = $('mapBgm');
  const refreshMapping = () => {
    const disabled = auto.checked;
    localInput.disabled = disabled;
    bgmInput.disabled = disabled;
    const local = Number(localInput.value);
    const bgm = Number(bgmInput.value);
    $('mapPreview').textContent = disabled
      ? '按 Bangumi 的剧集列表重新推断（本地从第 67 集开始、Bangumi 从第 1 集开始这类情况会自动认出来）。'
      : Number.isFinite(local) && Number.isFinite(bgm)
        ? `本地集号 ${bgm - local >= 0 ? '+ ' : '− '}${Math.abs(bgm - local)} 后对应 Bangumi 集号。`
        : '请填写两个集号。';
  };
  auto.addEventListener('change', refreshMapping);
  localInput.addEventListener('input', refreshMapping);
  bgmInput.addEventListener('input', refreshMapping);
  refreshMapping();

  applyButton.addEventListener('click', async () => {
    if (!state.pendingCandidate) return;
    applyButton.disabled = true;
    applyButton.textContent = '应用中…';
    const mappingBody = auto.checked
      ? { auto: true }
      : { localNumber: Number(localInput.value), bangumiNumber: Number(bgmInput.value) };
    try {
      if (state.pendingCandidate === currentId) {
        await api(`/api/series/${series.id}/offset`, {
          method: 'POST',
          body: auto.checked ? { mode: 'auto' } : { mode: 'manual', ...mappingBody },
        });
      } else {
        await api(`/api/series/${series.id}/match`, {
          method: 'POST',
          body: { bangumiId: state.pendingCandidate, ...mappingBody },
        });
      }
      state.matchSeriesId = null;
      await loadData({ quiet: true });
      await openDetail(series.id);
      toast(state.pendingCandidate === currentId ? '已更新集号对应' : '已重新绑定');
    } catch (error) {
      toast(`操作失败：${error.message}`, true);
      applyButton.disabled = false;
      applyButton.textContent = '应用更改';
    }
  });

  runSearch(series.source_folder ?? '');
}

/* ------------------------------------------------------------------ scan */

async function startScan() {
  try {
    const result = await api('/api/scan', { method: 'POST' });
    if (!result.started) toast(result.reason ?? '扫描已经在进行');
    pollScan();
  } catch (error) {
    toast(`扫描启动失败：${error.message}`, true);
  }
}

let pollTimer = null;
let scanStream = null;
let scanStreamErrors = 0;
let scanTicks = 0;

async function handleScanStatus(status) {
  if (!status) return;
  const wasRunning = state.scan.running;
  const previousFinish = state.scan.last?.finishedAt ?? null;
  state.scan = status;
  renderScanStatus();

  if (status.running) {
    scanTicks += 1;
    if (scanTicks % 5 === 0) await loadData({ quiet: true }).catch(() => {});
    return;
  }

  const finished = Boolean(status.last?.finishedAt) && status.last.finishedAt !== previousFinish;
  if (wasRunning || finished) {
    scanTicks = 0;
    await loadData({ quiet: true }).catch(() => {});
    if (status.last) {
      toast(`扫描完成：${status.last.groups} 组，自动匹配 ${status.last.matched}，待确认 ${status.last.unmatched}`);
    }
  }
}

function connectScanStream() {
  if (typeof EventSource === 'undefined' || scanStream) return;
  try {
    scanStream = new EventSource('/api/scan/stream');
    scanStream.onopen = () => {
      scanStreamErrors = 0;
    };
    scanStream.onmessage = (event) => {
      try {
        handleScanStatus(JSON.parse(event.data));
      } catch {
        /* ignore a malformed frame */
      }
    };
    scanStream.onerror = () => {
      scanStreamErrors += 1;
      if (scanStreamErrors > 5) {
        scanStream.close();
        scanStream = null;
      }
    };
  } catch {
    scanStream = null;
  }
}

function pollScan() {
  clearTimeout(pollTimer);
  const tick = async () => {
    try {
      await handleScanStatus(await api('/api/scan/status'));
    } catch {
      /* try again on the next tick */
    }
    const idleDelay = scanStream ? 30000 : 5000;
    pollTimer = setTimeout(tick, state.scan.running ? 1500 : idleDelay);
  };
  tick();
}

/* ---------------------------------------------------------------- overlays */

function openOverlay(html, options = {}) {
  overlayPanel.innerHTML = html;
  overlayPanel.classList.remove('detail-panel');
  overlayPanel.classList.toggle('narrow', Boolean(options.narrow));
  overlayPanel.classList.toggle('dialog-panel', Boolean(options.narrow || options.match));
  overlayPanel.classList.toggle('match-panel', Boolean(options.match));
  overlay.hidden = false;
  document.documentElement.classList.add('has-overlay');
}

function closeDetailMenu() {
  const menu = $('detailMenu');
  if (!menu) return;
  menu.hidden = true;
  document.querySelector('[data-action="detail-more"]')?.setAttribute('aria-expanded', 'false');
}

function closeMatchDialog() {
  const seriesId = state.matchSeriesId;
  state.matchSeriesId = null;
  if (seriesId) openDetail(seriesId);
  else closeOverlay();
}

function closeOverlay() {
  closeFileInfo();
  closeDetailMenu();
  state.matchSeriesId = null;
  overlay.hidden = true;
  overlayPanel.innerHTML = '';
  overlayPanel.classList.remove('detail-panel', 'dialog-panel', 'narrow', 'match-panel');
  document.documentElement.classList.remove('has-overlay');
  state.detail = null;
  state.detailGroups = null;
  state.pendingCandidate = null;
}

/* ----------------------------------------------------------------- events */

async function toggleFavorite(seriesId, favorite) {
  const item = state.items.find((entry) => entry.id === seriesId);
  if (item) item.favorite = favorite;
  if (state.detail?.series.id === seriesId) state.detail.series.favorite = favorite;
  renderCurrentPage();
  if (state.detail?.series.id === seriesId) renderDetail();
  try {
    await api(`/api/series/${seriesId}/favorite`, { method: 'POST', body: { favorite } });
    toast(favorite ? '已加入收藏' : '已取消收藏');
  } catch (error) {
    if (item) item.favorite = !favorite;
    renderCurrentPage();
    toast(`收藏失败：${error.message}`, true);
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!target.closest('.head-more')) closeDetailMenu();
  else if (target.closest('.action-menu-item') && !target.closest('[data-action]')) closeDetailMenu();
  if (target === overlay) {
    return overlayPanel.classList.contains('match-panel') ? closeMatchDialog() : closeOverlay();
  }
  if (target === fileOverlay) return closeFileInfo();

  const infoButton = target.closest('[data-file-info]');
  if (infoButton) {
    event.preventDefault();
    return openFileInfo(Number(infoButton.dataset.fileInfo));
  }

  const nav = target.closest('[data-nav]');
  if (nav) {
    event.preventDefault();
    goPage(nav.dataset.nav);
    return undefined;
  }

  const fav = target.closest('[data-favorite]');
  if (fav) {
    event.preventDefault();
    const seriesId = Number(fav.dataset.favorite);
    return toggleFavorite(seriesId, !isFavorite(seriesId));
  }

  const action = target.closest('[data-action]')?.dataset.action;

  if (action === 'close') return closeOverlay();
  if (action === 'match-close') return closeMatchDialog();
  if (action === 'file-close') return closeFileInfo();
  if (action === 'detail-more') {
    const menu = $('detailMenu');
    if (menu) {
      menu.hidden = !menu.hidden;
      target.closest('[data-action="detail-more"]')?.setAttribute('aria-expanded', String(!menu.hidden));
    }
    return undefined;
  }
  if (['unwatch-all', 'reveal-series', 'rematch', 'reveal-folder'].includes(action)) closeDetailMenu();
  if (action === 'reveal-series' || action === 'reveal-folder') return revealSeriesFolder();

  if (action === 'tab') {
    const tab = target.closest('[data-tab]');
    if (tab) selectTab(tab.dataset.tab);
    return undefined;
  }

  if (action === 'favorite' && state.detail) {
    const seriesId = state.detail.series.id;
    return toggleFavorite(seriesId, !isFavorite(seriesId));
  }

  if (action === 'play') {
    event.stopPropagation();
    try {
      await playFile(target.closest('[data-action="play"]').dataset.file);
    } catch (error) {
      toast(`无法播放：${error.message}`, true);
    }
    return undefined;
  }

  const playNext = target.closest('[data-play-file]');
  if (playNext) {
    try {
      await playFile(playNext.dataset.playFile);
    } catch (error) {
      toast(`无法播放：${error.message}`, true);
    }
    return undefined;
  }

  const row = target.closest('.ep-row');
  if (row && action === 'toggle' && state.detail) {
    const itemKey = row.dataset.itemKey;
    const watched = !row.classList.contains('is-watched');
    row.classList.toggle('is-watched', watched);
    try {
      const result = await api(`/api/series/${state.detail.series.id}/watch`, {
        method: 'POST',
        body: { itemKey, watched },
      });
      const entry = [...state.detail.episodes, ...state.detail.missing, ...state.detail.extras].find(
        (candidate) => candidate.itemKey === itemKey
      );
      if (entry) entry.watched = watched;
      state.detail.progress = result.progress;
      state.detail.series.progress = result.progress;
      const series = state.items.find((item) => item.id === state.detail.series.id);
      if (series) series.progress = result.progress;
      updateProgressUi();
      await loadData({ quiet: true });
    } catch (error) {
      row.classList.toggle('is-watched', !watched);
      toast(`保存失败：${error.message}`, true);
    }
    return undefined;
  }

  if ((action === 'watch-all' || action === 'unwatch-all') && state.detail) {
    try {
      await api(`/api/series/${state.detail.series.id}/watch-all`, {
        method: 'POST',
        body: { watched: action === 'watch-all' },
      });
      const seriesId = state.detail.series.id;
      await loadData({ quiet: true });
      await openDetail(seriesId);
    } catch (error) {
      toast(`操作失败：${error.message}`, true);
    }
    return undefined;
  }

  if (action === 'rematch') openMatchDialog();

  const calendarDay = target.closest('[data-calendar-day]');
  if (calendarDay) {
    const key = calendarDay.dataset.calendarDay;
    const date = new Date(`${key}T00:00:00`);
    state.calendar = { year: date.getFullYear(), month: date.getMonth(), selected: key };
    renderTimeline();
    return undefined;
  }

  const shift = target.closest('[data-calendar-shift]');
  if (shift) {
    const next = new Date(state.calendar.year, state.calendar.month + Number(shift.dataset.calendarShift), 1);
    state.calendar = {
      year: next.getFullYear(),
      month: next.getMonth(),
      selected: dateKey(new Date(next.getFullYear(), next.getMonth(), 1)),
    };
    renderTimeline();
    return undefined;
  }

  if (target.closest('[data-timeline-today]')) {
    const today = new Date();
    state.calendar = { year: today.getFullYear(), month: today.getMonth(), selected: dateKey(today) };
    renderTimeline();
    return undefined;
  }

  const timelineDay = target.closest('[data-timeline-day]');
  if (timelineDay) {
    goPage('timeline');
    const key = timelineDay.dataset.timelineDay;
    const date = new Date(`${key}T00:00:00`);
    state.calendar = { year: date.getFullYear(), month: date.getMonth(), selected: key };
    renderTimeline();
    return undefined;
  }

  const homeTab = target.closest('[data-home-tab]');
  if (homeTab) {
    state.homeTab = homeTab.dataset.homeTab;
    renderHome();
    return undefined;
  }

  if (target.closest('[data-additions-toggle]')) {
    state.additionsExpanded = !state.additionsExpanded;
    renderHome();
    return undefined;
  }

  const filter = target.closest('[data-filter]');
  if (filter) {
    state.filter = filter.dataset.filter;
    renderLibrary();
    return undefined;
  }

  const type = target.closest('[data-type]');
  if (type) {
    state.type = type.dataset.type;
    renderLibrary();
    return undefined;
  }

  const year = target.closest('[data-year]');
  if (year) {
    state.year = year.dataset.year;
    renderLibrary();
    return undefined;
  }

  const view = target.closest('[data-view]');
  if (view) {
    state.view = view.dataset.view;
    renderLibrary();
    return undefined;
  }

  const favType = target.closest('[data-fav-type]');
  if (favType) {
    state.favType = favType.dataset.favType;
    renderFavorites();
    return undefined;
  }

  if (target.closest('[data-clear-query]')) {
    state.query = '';
    $('search').value = '';
    renderLibrary();
    return undefined;
  }

  if (target.closest('[data-scan]')) {
    startScan();
    return undefined;
  }

  const settingsTab = target.closest('[data-settings-tab]');
  if (settingsTab) {
    selectSettingsTab(settingsTab.dataset.settingsTab);
    return undefined;
  }

  const themeSwatch = target.closest('[data-theme-id]');
  if (themeSwatch) {
    const theme = THEMES.find((item) => item.id === themeSwatch.dataset.themeId);
    if (theme) {
      setTheme(theme, { persist: true });
      markThemeSelection();
    }
    return undefined;
  }

  const dockChoice = target.closest('[data-dock-to]');
  if (dockChoice) {
    applyDock(dockChoice.dataset.dockTo, { persist: true });
    for (const node of document.querySelectorAll('[data-dock-to]')) {
      node.classList.toggle('is-active', node.dataset.dockTo === state.dock);
    }
    return undefined;
  }

  const setting = target.closest('[data-setting]')?.dataset.setting;
  if (setting === 'pick-bg') {
    $('bgFile')?.click();
    return undefined;
  }
  if (setting === 'clear-bg') {
    saveBackground({ clear: true });
    return undefined;
  }
  if (setting === 'save-library') {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          scanDirs: $('setDirs').value.split('\n').map((line) => line.trim()).filter(Boolean),
        },
      });
      state.settings = await api('/api/settings');
      toast('扫描目录已保存');
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
    return undefined;
  }
  if (setting === 'save-match') {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          matchThreshold: Number($('setThreshold').value),
          matchMargin: Number($('setMargin').value),
        },
      });
      state.settings = await api('/api/settings');
      renderSettings();
      toast('识别设置已保存');
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
    return undefined;
  }
  if (setting === 'save-network') {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: { proxy: $('setProxy').value.trim() },
      });
      state.settings = await api('/api/settings');
      renderSettings();
      toast('网络设置已保存（代理改动需要重启程序）');
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
    return undefined;
  }
  if (setting === 'clear-cache') {
    if (!window.desktopWindow?.clearCache) return undefined;
    try {
      const result = await window.desktopWindow.clearCache();
      if (result?.canceled) return undefined;
      toast(result?.freed ? `已释放 ${result.freed}` : '缓存已清理');
      refreshCacheInfo();
    } catch (error) {
      toast(`清理缓存失败：${error.message}`, true);
    }
    return undefined;
  }
  if (setting === 'reset-prefs') {
    setTheme(THEMES[0], { persist: true });
    applyMode('dark', { persist: true });
    applyDock('bottom', { persist: true });
    applyGlass(26, { persist: true });
    renderSettingsBody();
    toast('外观已恢复默认');
    return undefined;
  }

  const seriesCard = target.closest('[data-series]');
  if (seriesCard) return openDetail(Number(seriesCard.dataset.series));

  return undefined;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !fileOverlay.hidden) closeFileInfo();
  else if (event.key === 'Escape' && !$('detailMenu')?.hidden) closeDetailMenu();
  else if (event.key === 'Escape' && !overlay.hidden) {
    if (overlayPanel.classList.contains('match-panel')) closeMatchDialog();
    else closeOverlay();
  }
  const tag = document.activeElement?.tagName;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
  if (event.key === '/' && overlay.hidden && !typing) {
    event.preventDefault();
    $('search').focus();
  }
  if (event.key === 'Enter' && overlay.hidden && !typing) {
    const card = document.activeElement?.closest?.('[data-series]');
    if (card) openDetail(Number(card.dataset.series));
  }
});

document.addEventListener('dblclick', async (event) => {
  const row = event.target.closest('.ep-row');
  if (!row || !state.detail) return;
  if (event.target.closest('.ep-check, .ep-actions, .file-meta')) return;
  const fileId = row.dataset.fileId;
  if (!fileId) {
    toast('这一集本地没有文件', true);
    return;
  }
  try {
    await playFile(fileId);
  } catch (error) {
    toast(`无法播放：${error.message}`, true);
  }
});

async function playFile(fileId) {
  await api(`/api/files/${fileId}/play`, { method: 'POST' });
  toast('已用系统默认播放器打开');
}

$('btnMode').addEventListener('click', () => applyMode(currentMode() === 'dark' ? 'light' : 'dark', { persist: true }));

window.addEventListener('hashchange', () => setPage(pageFromHash()));
window.addEventListener('focus', () => pollScan());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollScan();
});

let searchDebounce = null;
$('search').addEventListener('input', (event) => {
  const value = event.target.value;
  state.query = value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    if (state.page !== 'library') {
      history.replaceState(null, '', '#/library');
      setPage('library');
    } else {
      renderLibrary();
    }
  }, 140);
});

/* ------------------------------------------------------------------ start */

function boot() {
  state.calendar.selected = dateKey(new Date());
  document.querySelector('[data-icon="search"]').innerHTML = icon('search');
  $('btnGotoSettings').innerHTML = icon('settings');
  applyTheme(currentTheme());
  applyMode(currentMode());
  applyDock(readStore(STORE.dock) ?? 'bottom');
  applyGlass(Number(readStore(STORE.glass) ?? 26));
  setupWindowControls();
  renderDock();

  if (!location.hash) history.replaceState(null, '', '#/home');
  setPage(pageFromHash());

  loadAppearance();
  loadPreferences();
  connectScanStream();
  loadData().then(() => pollScan());
}

boot();
