/* 本地番剧媒体库管理器 — 前端（原生 JS，无构建步骤） */

const state = {
  items: [],
  recent: [],
  stats: {},
  lastScan: null,
  filter: 'all',
  sort: 'recent',
  query: '',
  scan: { running: false, progress: null, last: null },
  detail: null,
  detailTab: 'episodes',
  detailGroups: null,
  appearance: { hasImage: false, url: null, blur: 0, brightness: 1 },
  pendingCandidate: null,
};

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const emptyState = $('emptyState');
const overlay = $('overlay');
const overlayPanel = $('overlayPanel');

/* ------------------------------------------------------------- icon set */

const ICONS = {
  // Five deliberately different silhouettes — a grid, a warning triangle, a
  // hollow ring, a screen with a play mark and a bare tick — so the categories
  // can be told apart at a glance instead of all being variants of a circle.
  all:
    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7.4" height="7.4" rx="2.2"/><rect x="13.6" y="3" width="7.4" height="7.4" rx="2.2"/><rect x="3" y="13.6" width="7.4" height="7.4" rx="2.2"/><rect x="13.6" y="13.6" width="7.4" height="7.4" rx="2.2"/></svg>',
  unmatched:
    '<svg viewBox="0 0 24 24"><path d="M12 4.1 2.9 19.5a1.2 1.2 0 0 0 1 1.8h16.2a1.2 1.2 0 0 0 1-1.8z"/><path d="M12 9.4v4.3"/><circle cx="12" cy="17.1" r="1" class="solid"/></svg>',
  none: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.3"/><circle cx="12" cy="12" r="4.1" stroke-dasharray="1.6 2.6"/></svg>',
  watching:
    '<svg viewBox="0 0 24 24"><rect x="2.7" y="4.6" width="18.6" height="14.8" rx="4"/><path d="M10.3 9.5 15 12l-4.7 2.5z" class="solid"/></svg>',
  completed: '<svg viewBox="0 0 24 24"><path d="M4.4 12.7 9.2 17.5 19.6 6.5" stroke-width="2.4"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M3.6 7.6a2 2 0 0 1 2-2h3.1l1.8 2.2h6.9a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z"/><circle cx="13.6" cy="13.4" r="2.7"/><path d="m15.6 15.4 2.5 2.5"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/></svg>',
};

const MODE_ICONS = {
  // Sun while dark (click to go light), moon while light.
  dark: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.1"/><path d="M12 2.6v2.3M12 19.1v2.3M4.6 12H2.3M21.7 12h-2.3M6.9 6.9 5.3 5.3M18.7 18.7l-1.6-1.6M6.9 17.1l-1.6 1.6M18.7 5.3l-1.6 1.6"/></svg>',
  light: '<svg viewBox="0 0 24 24"><path d="M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5a8.6 8.6 0 1 0 10.9 10.9Z"/></svg>',
};

const NAV_ITEMS = [
  { id: 'all', label: '全部' },
  { id: 'unmatched', label: '未识别' },
  { id: 'none', label: '未看' },
  { id: 'watching', label: '观看中' },
  { id: 'completed', label: '已看完' },
];

/* ------------------------------------------------------------ preference */

const STORE = {
  collapsed: 'anime-library.sidebar-collapsed',
  theme: 'anime-library.theme',
  mode: 'anime-library.mode',
};

const THEMES = [
  { id: 'indigo', label: '靛蓝', accent: '#6c8cff', accent2: '#a06cff' },
  { id: 'sakura', label: '樱粉', accent: '#ff6fa5', accent2: '#ff9a6c' },
  { id: 'mint', label: '薄荷', accent: '#3fd0a8', accent2: '#4fa8ff' },
  { id: 'amber', label: '琥珀', accent: '#f0a336', accent2: '#ff6f5a' },
  { id: 'violet', label: '紫罗兰', accent: '#9b6cff', accent2: '#e070ff' },
  { id: 'graphite', label: '石墨', accent: '#8d9bb5', accent2: '#c0c9dc' },
];

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
  if (!Number.isFinite(number)) return `rgba(108, 140, 255, ${alpha})`;
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

function applyTheme(theme) {
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.accent);
  root.setProperty('--accent-2', theme.accent2);
  root.setProperty('--accent-soft', hexToRgba(theme.accent, 0.15));
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

function setTheme(theme) {
  applyTheme(theme);
  writeStore(STORE.theme, JSON.stringify(theme));
}

function setCollapsed(collapsed) {
  $('layout').classList.toggle('is-collapsed', collapsed);
  writeStore(STORE.collapsed, collapsed ? '1' : '0');
}

const isCollapsed = () => $('layout').classList.contains('is-collapsed');

/* ------------------------------------------------------------ dark / light */

function applyMode(mode) {
  const next = mode === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.mode = next;
  writeStore(STORE.mode, next);
  const button = $('btnMode');
  if (button) {
    button.innerHTML = MODE_ICONS[next];
    button.title = next === 'dark' ? '切换到亮色' : '切换到深色';
  }
  return next;
}

/* ------------------------------------------------------ custom background */

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

/** Reads a picked file, shrinking it so a 20 MP photo does not become a huge payload. */
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
  const smallEnough = dataUrl.length < 3.2 * 1024 * 1024;
  if (scale === 1 && smallEnough) return dataUrl;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.86);
}

async function loadAppearance() {
  try {
    applyAppearance(await api('/api/appearance'));
  } catch {
    /* an unset background is not an error */
  }
}

function currentMode() {
  return readStore(STORE.mode) === 'light' ? 'light' : 'dark';
}

/* ------------------------------------------------------------------ utils */

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

const STATUS_LABEL = { none: '未看', watching: '观看中', completed: '已看完' };

function hashHue(text) {
  let hash = 0;
  for (let i = 0; i < String(text).length; i += 1) {
    hash = (hash * 31 + String(text).charCodeAt(i)) % 360;
  }
  return hash;
}

function posterFallback(title) {
  const hue = hashHue(title);
  return `background: linear-gradient(150deg, hsl(${hue} 45% 26%), hsl(${(hue + 48) % 360} 52% 16%))`;
}

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

function firstChar(text) {
  return String(text ?? '?').trim().slice(0, 1) || '?';
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

function coverHtml(item, className) {
  if (item.coverUrl) {
    return `<img class="${className}" src="${escapeHtml(item.coverUrl)}" alt="" loading="lazy" />`;
  }
  return `<div class="poster-fallback" style="${posterFallback(item.title_cn ?? '')}">${escapeHtml(firstChar(item.title_cn))}</div>`;
}

/* ---------------------------------------------------------------- library */

async function loadLibrary() {
  const data = await api('/api/library');
  state.items = data.items;
  state.recent = data.recent ?? [];
  state.stats = data.stats;
  state.lastScan = data.lastScan;
  renderCounts();
  renderContinue();
  renderGrid();
  renderSidebarStats();
}

function renderNav() {
  $('navList').innerHTML = NAV_ITEMS.map(
    (item) => `
      <button class="nav-item${item.id === state.filter ? ' is-active' : ''}" data-filter="${item.id}" title="${item.label}">
        <span class="nav-icon">${ICONS[item.id]}</span>
        <span class="nav-text">${item.label}</span>
        <span class="nav-count">0</span>
      </button>`
  ).join('');
}

function renderContinue() {
  // 继续观看 belongs to the overview only — a filtered list should stay filtered.
  const recent = state.filter === 'all' ? state.recent ?? [] : [];
  const section = $('continueSection');
  if (recent.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const latest = recent[0];
  $('continueSub').textContent = `最近观看：${latest.title ?? ''}`;
  $('continueRow').innerHTML = recent.slice(0, 4).map(renderContinueCard).join('');
}

function renderContinueCard(entry) {
  const progress = entry.progress ?? { percent: 0, watched: 0, total: 0 };
  const next = entry.nextEpisode;
  const nextText = next
    ? next.number != null
      ? `下一集 第 ${next.number} 集${next.title ? ` · ${next.title}` : ''}`
      : `未看：${next.title ?? ''}`
    : '全部看完了';
  const cover = entry.coverUrl
    ? `<img src="${escapeHtml(entry.coverUrl)}" alt="" loading="lazy" />`
    : `<div class="poster-fallback" style="${posterFallback(entry.title ?? '')}">${escapeHtml(firstChar(entry.title))}</div>`;

  return `
    <button class="continue-card" data-id="${entry.seriesId}">
      <div class="continue-cover">${cover}</div>
      <div class="continue-body">
        <div class="continue-name">${escapeHtml(entry.title ?? '未命名')}</div>
        <div class="continue-next">${escapeHtml(nextText)}</div>
        <div class="continue-track"><i style="width:${Math.round((progress.percent ?? 0) * 100)}%"></i></div>
      </div>
    </button>`;
}

function renderSidebarStats() {
  const { total, unmatched, watching, completed } = state.stats;
  const lines = [
    ['番剧', `${total} 部`],
    ['观看中', watching],
    ['已看完', completed],
  ];
  if (unmatched) lines.push(['待确认', unmatched]);
  const scan = state.lastScan?.finished_at
    ? `上次扫描 ${new Date(state.lastScan.finished_at).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })}`
    : '还没有扫描过';

  $('sidebarStats').innerHTML = `
    ${lines.map(([label, value]) => `<div class="stat-line"><span>${label}</span><b>${value}</b></div>`).join('')}
    <div class="stat-scan">${escapeHtml(scan)}</div>`;
}

function renderCounts() {
  const counts = {
    all: state.items.length,
    unmatched: state.items.filter((item) => item.match_state === 'unmatched').length,
    none: state.items.filter((item) => item.progress.status === 'none' && item.match_state !== 'unmatched').length,
    watching: state.items.filter((item) => item.progress.status === 'watching').length,
    completed: state.items.filter((item) => item.progress.status === 'completed').length,
  };
  for (const [id, value] of Object.entries(counts)) {
    const node = document.querySelector(`.nav-item[data-filter="${id}"] .nav-count`);
    if (node) node.textContent = value;
  }
}

const FILTER_LABEL = { all: '全部', unmatched: '未识别', none: '未看', watching: '观看中', completed: '已看完' };

function visibleItems() {
  const query = state.query.trim().toLowerCase();
  let items = state.items.filter((item) => {
    if (state.filter === 'unmatched') return item.match_state === 'unmatched';
    if (state.filter === 'all') return true;
    return item.progress.status === state.filter && item.match_state !== 'unmatched';
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
    progress: (a, b) => b.progress.percent - a.progress.percent || (b.rating ?? 0) - (a.rating ?? 0),
    files: (a, b) => b.progress.totalFiles - a.progress.totalFiles,
  };
  return items.sort(sorters[state.sort] ?? sorters.recent);
}

function renderGrid() {
  const items = visibleItems();
  $('toolbarInfo').textContent = `「${FILTER_LABEL[state.filter]}」 ${items.length} 部${
    state.query ? ` · 搜索 “${state.query}”` : ''
  }`;

  if (items.length === 0) {
    grid.innerHTML = '';
    emptyState.hidden = false;
    emptyState.innerHTML = state.items.length
      ? '<div>没有符合条件的番剧</div><div style="font-size:12.5px">换个筛选条件或清空搜索试试。</div>'
      : `<div style="font-size:16px">媒体库还是空的</div>
         <div style="font-size:12.5px;max-width:460px">点右上角「扫描」开始整理。默认扫描目录是 <code>E:\\Videos\\Anime</code>，可以在「设置」里修改。</div>`;
    return;
  }
  emptyState.hidden = true;
  grid.innerHTML = items.map(renderCard).join('');
}

function renderCard(item) {
  const progress = item.progress;
  const badges = [];
  if (item.match_state === 'unmatched') badges.push('<span class="badge badge-unmatched">待确认</span>');
  if (item.media_kind === 'movie') badges.push('<span class="badge badge-movie">剧场版</span>');
  // A film shows both its type and its watch state, so 已看完 is visible too.
  if (progress.status !== 'none') {
    badges.push(`<span class="badge badge-${progress.status}">${STATUS_LABEL[progress.status]}</span>`);
  }

  const percent = Math.round(progress.percent * 100);
  const progressClass = progress.status === 'completed' ? 'poster-progress is-complete' : 'poster-progress';

  return `
    <button class="card" data-id="${item.id}">
      <div class="poster">
        ${coverHtml(item)}
        <div class="poster-badges">${badges.join('')}</div>
        <div class="${progressClass}"><i style="width:${percent}%"></i></div>
        <div class="poster-hover">
          正片 ${progress.localTotal}${progress.total ? ` / ${progress.total}` : ''} 集 · 特别篇 ${progress.specials}<br />
          ${escapeHtml(item.source_folder ?? '')}
        </div>
      </div>
      <div class="card-title" title="${escapeHtml(item.title_cn ?? '')}">${escapeHtml(item.title_cn ?? '未命名')}</div>
      <div class="card-sub">
        <span>${progress.total ? `${progress.watched}/${progress.total} 集` : `${progress.totalFiles} 个文件`}</span>
        <span>${item.rating ? `★ ${item.rating.toFixed(1)}` : ''}</span>
      </div>
    </button>`;
}

/* ----------------------------------------------------------------- detail */

async function openDetail(seriesId) {
  openOverlay('<div class="dialog-body"><span class="spinner"></span> 正在载入…</div>');
  state.detailTab = null;
  state.detailGroups = null;
  try {
    const data = await api(`/api/series/${seriesId}`);
    state.detail = data;
    renderDetail();
  } catch (error) {
    overlayPanel.innerHTML = `<div class="dialog-body">载入失败：${escapeHtml(error.message)}</div>`;
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

/**
 * Desktop layout: a fixed-height panel with the series info on the left and a
 * separately scrolling episode column on the right, so a 50-episode back
 * catalogue never pushes the artwork off screen.
 */
function renderDetail() {
  const { series, progress, episodes, missing, extras, counts, sourceFolder } = state.detail;
  overlayPanel.classList.remove('narrow');
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
  // Land on whichever tab actually has content — a movie-only entry has no
  // episodes, so opening on an empty 正片 tab would just look broken.
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
    ? `<a class="btn btn-small btn-ghost" href="https://bgm.tv/subject/${series.bangumi_id}" target="_blank" rel="noreferrer">Bangumi</a>`
    : '';

  overlayPanel.innerHTML = `
    <header class="detail-topbar">
      <button class="icon-btn" data-action="close" title="返回（Esc）">←</button>
      <div class="detail-topbar-title">
        <strong>${escapeHtml(series.title_cn ?? '未命名')}</strong>
        <span>${escapeHtml(sourceFolder ?? '')}</span>
      </div>
      <div class="detail-topbar-actions">
        <button class="btn btn-small btn-primary" data-action="watch-all">全部已看</button>
        <button class="btn btn-small btn-ghost" data-action="unwatch-all">全部未看</button>
        <button class="btn btn-small btn-ghost" data-action="rematch">重新匹配</button>
        ${bangumiLink}
      </div>
    </header>
    <div class="detail-body">
      <aside class="detail-aside">
        <div class="aside-head">
          <div class="detail-cover">${coverHtml(series)}</div>
          <div class="aside-head-main">
            <h2 class="detail-title">${escapeHtml(series.title_cn ?? '未命名')}</h2>
            ${series.title_orig ? `<div class="detail-orig">${escapeHtml(series.title_orig)}</div>` : ''}
          </div>
        </div>
        <div class="tag-row">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
        <div class="progress-block">
          <div class="progress-line">
            <span class="progress-text">${STATUS_LABEL[progress.status]} · ${progress.watched}/${
    progress.total || progress.localTotal
  } 集</span>
            <span class="track"><i style="width:${Math.round(progress.percent * 100)}%"></i></span>
            <span class="progress-percent">${Math.round(progress.percent * 100)}%</span>
          </div>
        </div>
        ${series.summary ? `<div class="detail-summary">${escapeHtml(series.summary)}</div>` : ''}
        <div class="source-block">
          <div class="source-label">集号对应</div>
          ${
            series.bangumi_id
              ? `<div class="mapping-value">${escapeHtml(mappingText)}</div>
                 <div class="source-meta">${escapeHtml(mappingMeta)}（在「重新匹配」里调整）</div>`
              : '<div class="source-meta">匹配到 Bangumi 之后才能计算集号对应关系。</div>'
          }
        </div>
        <div class="source-block">
          <div class="source-label">来源</div>
          <code>${escapeHtml(sourceFolder ?? '')}</code>
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
                `<button class="tab${tab.id === state.detailTab ? ' is-active' : ''}" data-action="tab" data-tab="${
                  tab.id
                }">${tab.label}<span class="tab-count">${tab.count}</span></button>`
            )
            .join('')}
        </div>
        <div class="ep-scroll" id="epPane">${episodePaneContent()}</div>
      </section>
    </div>`;
}

function episodePaneContent() {
  const list = state.detailGroups?.[state.detailTab] ?? [];
  if (list.length === 0) {
    return `<div class="pane-empty">${
      state.detailTab === 'episodes' ? '没有识别到正片文件' : '这里还没有内容'
    }</div>`;
  }
  if (state.detailTab === 'specials' || state.detailTab === 'movies') {
    return list.map(renderExtraRow).join('');
  }
  return list.map(renderEpisodeRow).join('');
}

function selectTab(tabId) {
  state.detailTab = tabId;
  for (const node of overlayPanel.querySelectorAll('.tab')) {
    node.classList.toggle('is-active', node.dataset.tab === tabId);
  }
  const pane = document.getElementById('epPane');
  if (pane) pane.innerHTML = episodePaneContent();
}

/** Patches the progress readout in place so toggling never resets list scroll. */
function updateProgressUi() {
  const { progress } = state.detail ?? {};
  if (!progress) return;
  const text = overlayPanel.querySelector('.progress-text');
  const percent = overlayPanel.querySelector('.progress-percent');
  const bar = overlayPanel.querySelector('.progress-line .track > i');
  if (text) text.textContent = `${STATUS_LABEL[progress.status]} · ${progress.watched}/${progress.total || progress.localTotal} 集`;
  if (percent) percent.textContent = `${Math.round(progress.percent * 100)}%`;
  if (bar) bar.style.width = `${Math.round(progress.percent * 100)}%`;
}

function renderEpisodeRow(episode) {
  const shifted = episode.bangumiNumber != null && episode.bangumiNumber !== episode.number;
  const label = shifted
    ? `本地 ${episode.number} · BGM ${episode.bangumiNumber}`
    : `第 ${episode.number} 集`;
  const playButtons = (episode.files ?? [])
    .map(
      (file) =>
        `<button class="btn btn-small btn-ghost" data-action="play" data-file="${file.id}" title="${escapeHtml(
          file.path
        )}">▶ 播放</button>`
    )
    .join('');
  const first = episode.files?.[0];
  const pathHint = first
    ? `<div class="file-path" title="${escapeHtml(first.path)}">${escapeHtml(first.name)}${
        episode.files.length > 1 ? ` (+${episode.files.length - 1})` : ''
      } · ${formatSize(first.size)}</div>`
    : '';

  const titleText = episode.title
    ? escapeHtml(episode.title)
    : episode.inLibrary
      ? '<span class="muted">（本地特有集，Bangumi 正片列表未收录）</span>'
      : '<span class="muted">（Bangumi 未提供这一集的标题）</span>';
  const playable = episode.files?.[0]?.id ?? '';

  return `
    <div class="ep-row ${episode.watched ? 'is-watched' : ''}" data-item-key="${escapeHtml(episode.itemKey)}" data-file-id="${playable}"${
      playable ? ' title="双击用系统默认播放器打开"' : ''
    }>
      <button class="ep-check" data-action="toggle" title="标记已看 / 未看">✓</button>
      <span class="ep-number">${escapeHtml(label)}</span>
      <span class="ep-main">
        <span class="ep-title" title="${escapeHtml(episode.title ?? '')}">${titleText}${
    episode.inLibrary ? '' : ' <span class="muted">· 本地缺</span>'
  }</span>
        ${pathHint}
      </span>
      <span class="ep-actions">${playButtons}</span>
    </div>`;
}

function renderExtraRow(extra) {
  const file = extra.files?.[0];
  const short = file ? extraLabel(file.name) : extra.title;
  const number = file?.epLabel ? `#${file.epLabel} ` : '';
  return `
    <div class="ep-row ${extra.watched ? 'is-watched' : ''}" data-item-key="${escapeHtml(extra.itemKey)}" data-file-id="${
      file?.id ?? ''
    }"${file?.id ? ' title="双击用系统默认播放器打开"' : ''}>
      <button class="ep-check" data-action="toggle" title="标记已看 / 未看">✓</button>
      <span class="ep-number">${extra.kind === 'movie' ? '剧场版' : '特别篇'}</span>
      <span class="ep-main">
        <span class="ep-title" title="${escapeHtml(short)}">${number}${escapeHtml(short)}</span>
        <span class="file-path" title="${escapeHtml(file?.path ?? '')}">${escapeHtml(file?.name ?? '')} · ${formatSize(
    file?.size
  )}</span>
      </span>
      <span class="ep-actions">
        <button class="btn btn-small btn-ghost" data-action="play" data-file="${file?.id}">▶ 播放</button>
      </span>
    </div>`;
}

const RELEASE_NOISE = /raws|fansub|kissaten|house|studio|\bsub\b|sub$|字幕组|压制/i;
const METADATA_TAG =
  /\b(?:1080|720|2160|1440|480|576)p\b|\b(?:x|h)26[45]\b|HEVC|AVC|AAC|FLAC|EAC3|AC3|DTS|\d+bit|BDRip|WebRip|TVRip|UHDRip|DVDRip|\b(?:CHS|CHT|GB|BIG5|JPSC|JPTC|JPN|SC|TC)\b|\b(?:MKV|MP4|AVI)\b|\bFin\b/i;

const labelKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');

/**
 * Release file names are long and full of noise. Pull out just the part that
 * tells the user what this extra actually is ("歌曲欣赏", "NCED", "menu #01").
 */
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

/* ------------------------------------------------------------- match dialog */

async function openMatchDialog() {
  const { series } = state.detail;
  openOverlay(
    `<div class="dialog-head"><h3>重新匹配番剧</h3><button class="btn btn-small btn-ghost" data-action="close">关闭</button></div>
     <div class="dialog-body">
       <div class="field">
         <label>当前文件夹</label>
         <div class="field-hint"><code>${escapeHtml(series.source_folder ?? '')}</code></div>
       </div>
       <div class="field">
         <label for="matchQuery">搜索 Bangumi</label>
         <input id="matchQuery" type="text" value="${escapeHtml(series.source_folder ?? '')}" />
         <div class="field-hint">支持中文名、日文原名、罗马音。列表里标着「当前」的就是现在绑定的条目。</div>
       </div>
       <div class="candidate-list" id="candidateList"><span class="spinner"></span></div>
       <div class="field mapping-block">
         <label class="check-row"><input type="checkbox" id="mapAuto" ${
           state.detail.mapping?.auto !== false ? 'checked' : ''
         } /> 自动推断集号对应</label>
         <div class="mapping-inputs">
           <span>本地第</span>
           <input id="mapLocal" type="number" step="1" value="${state.detail.mapping?.localMin ?? 1}" />
           <span>集 = Bangumi 第</span>
           <input id="mapBgm" type="number" step="1" value="${(state.detail.mapping?.localMin ?? 1) + (state.detail.mapping?.offset ?? 0)}" />
           <span>集</span>
         </div>
         <div class="field-hint" id="mapPreview"></div>
       </div>
     </div>
     <div class="dialog-foot">
       <button class="btn btn-ghost" data-action="close">取消</button>
         <button class="btn btn-primary" id="btnBind" disabled>应用</button>
     </div>`,
    { narrow: true }
  );

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

  const runSearch = async (keyword) => {
    const list = $('candidateList');
    list.innerHTML = '<span class="spinner"></span> 搜索中…';
    try {
      const data = keyword
        ? await api(`/api/search?q=${encodeURIComponent(keyword)}`)
        : await api(`/api/series/${series.id}/candidates`);
      const results = data.candidates ?? [];
      // Keep the currently bound entry visible and selected, so the mapping can
      // be adjusted without having to search for it again.
      const list2 = currentCandidate ? [currentCandidate, ...results.filter((c) => c.bangumiId !== currentId)] : results;
      state.pendingCandidate = currentId;
      $('btnBind').disabled = !currentId;
      renderCandidates(list, list2);
    } catch (error) {
      list.innerHTML = `<div class="muted">搜索失败：${escapeHtml(error.message)}</div>`;
    }
  };

  const input = $('matchQuery');
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
  $('candidateList').addEventListener('click', (event) => {
    const card = event.target.closest('.candidate');
    if (!card) return;
    for (const node of $('candidateList').querySelectorAll('.candidate')) node.classList.remove('is-selected');
    card.classList.add('is-selected');
    state.pendingCandidate = Number(card.dataset.id);
    $('btnBind').disabled = false;
  });

  // Episode mapping controls
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
      ? '重新按 Bangumi 的剧集列表推断（本地从第 67 集开始、Bangumi 从第 1 集开始这类情况会自动认出来）。'
      : Number.isFinite(local) && Number.isFinite(bgm)
        ? `即：本地集号 ${bgm - local >= 0 ? '+ ' : '− '}${Math.abs(bgm - local)} 后对应 Bangumi 集号。`
        : '请填写两个集号。';
  };
  auto.addEventListener('change', refreshMapping);
  localInput.addEventListener('input', refreshMapping);
  bgmInput.addEventListener('input', refreshMapping);
  refreshMapping();

  $('btnBind').addEventListener('click', async () => {
    if (!state.pendingCandidate) return;
    const button = $('btnBind');
    button.disabled = true;
    button.textContent = '应用中…';
    const seriesId = series.id;
    const mappingBody = auto.checked
      ? { auto: true }
      : { localNumber: Number(localInput.value), bangumiNumber: Number(bgmInput.value) };
    try {
      if (state.pendingCandidate === currentId) {
        // Same subject — only the episode numbering changed.
        await api(`/api/series/${seriesId}/offset`, {
          method: 'POST',
          body: auto.checked ? { mode: 'auto' } : { mode: 'manual', ...mappingBody },
        });
      } else {
        await api(`/api/series/${seriesId}/match`, {
          method: 'POST',
          body: { bangumiId: state.pendingCandidate, ...mappingBody },
        });
      }
      await loadLibrary();
      await openDetail(seriesId);
      toast(state.pendingCandidate === currentId ? '已更新集号对应' : '已重新绑定');
    } catch (error) {
      toast(`操作失败：${error.message}`, true);
      button.disabled = false;
      button.textContent = '应用';
    }
  });

  runSearch(series.source_folder ?? '');
}

function renderCandidates(container, candidates) {
  if (!candidates.length) {
    container.innerHTML = '<div class="muted">没有搜索结果。换个关键词再试。</div>';
    return;
  }
  container.innerHTML = candidates
    .map((candidate) => {
      const cover = candidate.cover
        ? `<img src="${escapeHtml(candidate.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : '';
      return `
        <div class="candidate${candidate.current ? ' is-selected is-current' : ''}" data-id="${candidate.bangumiId}">
          <div class="candidate-cover">${cover}</div>
          <div class="candidate-body">
            <div class="candidate-title">${
              candidate.current ? '<span class="current-badge">当前</span>' : ''
            }${escapeHtml(candidate.title ?? '')}</div>
            <div class="candidate-meta">${escapeHtml(candidate.original ?? '')}</div>
            <div class="candidate-meta">${candidate.date ?? '播出日期未知'} · ${
        candidate.eps ? `${candidate.eps} 集` : '集数未知'
      }</div>
          </div>
          ${candidate.score != null ? `<span class="score-pill">${Math.round(candidate.score * 100)}%</span>` : ''}
        </div>`;
    })
    .join('');
}


/* --------------------------------------------------------------- settings */

async function openSettings() {
  openOverlay('<div class="dialog-body"><span class="spinner"></span> 正在载入设置…</div>', { narrow: true });
  let settings;
  try {
    settings = await api('/api/settings');
  } catch (error) {
    overlayPanel.innerHTML = `<div class="dialog-body">载入失败：${escapeHtml(error.message)}</div>`;
    return;
  }
  openOverlay(
    `<div class="dialog-head"><h3>设置</h3><button class="btn btn-small btn-ghost" data-action="close">关闭</button></div>
     <div class="dialog-body">
       <div class="field">
         <label>主题配色</label>
         <div class="theme-grid" id="themeGrid">
           ${THEMES.map(
             (theme) =>
               `<button class="theme-swatch" data-theme="${theme.id}" title="${theme.label}" style="background: linear-gradient(135deg, ${theme.accent}, ${theme.accent2})"></button>`
           ).join('')}
           <input class="theme-custom" id="themeCustom" type="color" value="${currentTheme().accent}" title="自定义颜色" />
         </div>
         <div class="field-hint">只影响按钮、进度条、选中态等强调色，保存在本机浏览器里。</div>
       </div>
       <div class="field">
         <label>背景图片</label>
         <div class="bg-row">
           <button class="btn btn-small btn-ghost" id="btnPickBg">选择图片…</button>
           <button class="btn btn-small btn-ghost" id="btnClearBg">清除背景</button>
           <input type="file" id="bgFile" accept="image/*" hidden />
         </div>
         <div class="field-hint" id="bgHint"></div>
       </div>
       <div class="field">
         <label for="bgBlur">背景模糊</label>
         <div class="range-row">
           <input type="range" id="bgBlur" min="0" max="30" step="1" />
           <span class="range-value" id="bgBlurValue"></span>
         </div>
       </div>
       <div class="field">
         <label for="bgBright">背景亮度</label>
         <div class="range-row">
           <input type="range" id="bgBright" min="30" max="150" step="1" />
           <span class="range-value" id="bgBrightValue"></span>
         </div>
       </div>
       <div class="field">
         <label for="setDirs">扫描目录（每行一个）</label>
         <textarea id="setDirs">${escapeHtml((settings.scanDirs ?? []).join('\n'))}</textarea>
         <div class="field-hint">程序只读扫描，不会移动、重命名或删除任何文件。</div>
       </div>
       <div class="field">
         <label for="setProxy">网络代理</label>
         <input id="setProxy" type="text" value="${escapeHtml(settings.proxy ?? 'auto')}" />
         <div class="field-hint">
           <code>auto</code> = 自动探测（环境变量、Windows 系统代理、常见本地端口）；留空 = 直连；也可填
           <code>http://127.0.0.1:7890</code>。当前实际使用：<code>${escapeHtml(settings.resolvedProxy ?? '直连')}</code>
         </div>
       </div>
       <div class="field">
         <label for="setThreshold">自动匹配阈值（0.3 – 0.95）</label>
         <input id="setThreshold" type="number" step="0.01" min="0.3" max="0.95" value="${settings.matchThreshold}" />
         <div class="field-hint">调高更保守（宁可让你手动确认），调低更激进（更容易自动绑定）。</div>
       </div>
       <div class="field">
         <label for="setMargin">自动匹配领先优势（0 – 0.5）</label>
         <input id="setMargin" type="number" step="0.01" min="0" max="0.5" value="${settings.matchMargin}" />
         <div class="field-hint">第一名必须比第二名高出这么多分才会自动绑定，避免在几个相似条目之间乱猜。</div>
       </div>
     </div>
     <div class="dialog-foot">
       <button class="btn btn-ghost" data-action="close">取消</button>
       <button class="btn btn-primary" id="btnSaveSettings">保存设置</button>
     </div>`,
    { narrow: true }
  );
  $('btnSaveSettings').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          scanDirs: $('setDirs').value.split('\n').map((line) => line.trim()).filter(Boolean),
          proxy: $('setProxy').value.trim(),
          matchThreshold: Number($('setThreshold').value),
          matchMargin: Number($('setMargin').value),
        },
      });
      closeOverlay();
      toast('设置已保存（代理改动需要重启程序）');
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
    }
  });

  const themeGrid = $('themeGrid');
  const markActiveTheme = () => {
    const active = currentTheme();
    for (const node of themeGrid.querySelectorAll('.theme-swatch')) {
      node.classList.toggle('is-active', node.dataset.theme === active.id);
    }
    $('themeCustom').value = active.accent;
  };
  themeGrid.addEventListener('click', (event) => {
    const swatch = event.target.closest('.theme-swatch');
    if (!swatch) return;
    const theme = THEMES.find((item) => item.id === swatch.dataset.theme);
    if (!theme) return;
    setTheme(theme);
    markActiveTheme();
  });
  $('themeCustom').addEventListener('input', (event) => {
    setTheme({ id: 'custom', label: '自定义', accent: event.target.value, accent2: event.target.value });
    markActiveTheme();
  });
  markActiveTheme();

  /* ---- background image ---- */
  const blurInput = $('bgBlur');
  const brightInput = $('bgBright');
  const bgHint = $('bgHint');

  const syncBackgroundUi = () => {
    const { hasImage, blur, brightness } = state.appearance;
    blurInput.value = String(blur);
    brightInput.value = String(Math.round(brightness * 100));
    $('bgBlurValue').textContent = `${blur} px`;
    $('bgBrightValue').textContent = `${Math.round(brightness * 100)}%`;
    bgHint.textContent = hasImage
      ? '已设置背景图。拖动滑块实时预览，松开后保存。'
      : '选一张图片作为页面背景，可以调模糊和亮度。图片存在本地数据目录，不会上传到别处。';
    $('btnClearBg').disabled = !hasImage;
  };
  syncBackgroundUi();

  const saveBackground = async (patch, { quiet = false } = {}) => {
    try {
      const result = await api('/api/appearance', { method: 'POST', body: patch });
      applyAppearance(result);
      syncBackgroundUi();
      if (!quiet) toast('背景已更新');
    } catch (error) {
      toast(`背景设置失败：${error.message}`, true);
      syncBackgroundUi();
    }
  };

  $('btnPickBg').addEventListener('click', () => $('bgFile').click());
  $('bgFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    bgHint.textContent = '正在处理图片…';
    try {
      await saveBackground({ image: await prepareBackgroundImage(file) });
    } catch (error) {
      toast(error.message, true);
      syncBackgroundUi();
    } finally {
      event.target.value = '';
    }
  });
  $('btnClearBg').addEventListener('click', () => saveBackground({ clear: true }));

  // Drag for a live preview, persist when the slider is released.
  for (const [input, key] of [
    [blurInput, 'blur'],
    [brightInput, 'brightness'],
  ]) {
    input.addEventListener('input', () => {
      const value = key === 'blur' ? Number(input.value) : Number(input.value) / 100;
      applyAppearance({ ...state.appearance, [key]: value });
      $('bgBlurValue').textContent = `${Number(blurInput.value)} px`;
      $('bgBrightValue').textContent = `${Number(brightInput.value)}%`;
    });
    input.addEventListener('change', () => {
      const value = key === 'blur' ? Number(input.value) : Number(input.value) / 100;
      saveBackground({ [key]: value }, { quiet: true });
    });
  }
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

/**
 * Reacts to a scan status, however it arrived (SSE push or polling fallback).
 *
 * Completion is detected from the run timestamp rather than from having seen
 * `running` flip: a warm-cache scan only takes a couple of seconds and could
 * otherwise start and finish between two updates.
 */
async function handleScanStatus(status) {
  if (!status) return;
  const wasRunning = state.scan.running;
  const previousFinish = state.scan.last?.finishedAt ?? null;
  state.scan = status;
  renderScanStatus();

  if (status.running) {
    scanTicks += 1;
    // Let the poster wall fill in as the scan walks the library.
    if (scanTicks % 5 === 0) await loadLibrary().catch(() => {});
    return;
  }

  const finished = Boolean(status.last?.finishedAt) && status.last.finishedAt !== previousFinish;
  if (wasRunning || finished) {
    scanTicks = 0;
    await loadLibrary().catch(() => {});
    if (status.last) {
      toast(
        `扫描完成：${status.last.groups} 组，自动匹配 ${status.last.matched}，待确认 ${status.last.unmatched}`
      );
    }
  }
}

/** Live progress — the server pushes it instead of the page asking for it. */
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
      // EventSource reconnects on its own; give up only if it keeps failing.
      if (scanStreamErrors > 5) {
        scanStream.close();
        scanStream = null;
      }
    };
  } catch {
    scanStream = null;
  }
}

/**
 * Safety net. Even with the stream connected this keeps a slow heartbeat, so a
 * missed event or a server restart cannot leave the UI stuck on a stale state.
 */
function pollScan() {
  clearTimeout(pollTimer);
  const tick = async () => {
    try {
      await handleScanStatus(await api('/api/scan/status'));
    } catch {
      /* try again on the next tick */
    }
    // While a scan runs, or if the push stream is unavailable, keep the old
    // cadence. When the stream is healthy and nothing is happening the poll is
    // only a safety net, so let it idle far less often.
    const idleDelay = scanStream ? 30000 : 5000;
    pollTimer = setTimeout(tick, state.scan.running ? 1500 : idleDelay);
  };
  tick();
}

function renderScanStatus() {
  const el = $('scanStatus');
  const { running, progress } = state.scan;
  const button = $('btnScan');
  if (!running) {
    el.innerHTML = '';
    button.disabled = false;
    // Rebuild rather than assign textContent — that would wipe the icon span.
    button.innerHTML = `<span class="side-icon">${ICONS.scan}</span><span class="side-text">扫描</span>`;
    return;
  }
  button.disabled = true;
  button.innerHTML = '<span class="side-icon"><span class="spinner"></span></span><span class="side-text">扫描中</span>';
  if (progress?.phase === 'match' && progress.total) {
    const percent = Math.round((progress.index / progress.total) * 100);
    el.innerHTML = `<div class="bar"><i style="width:${percent}%"></i></div>正在识别 ${progress.index}/${progress.total}<br />${escapeHtml(
      progress.folder ?? ''
    )}${progress.season ? ` (S${progress.season})` : ''}`;
  } else {
    el.innerHTML = '<div class="bar"><i style="width:12%"></i></div>正在扫描文件…';
  }
}

/* --------------------------------------------------------------- overlays */

function openOverlay(html, options = {}) {
  overlayPanel.innerHTML = html;
  overlayPanel.classList.toggle('narrow', Boolean(options.narrow));
  overlay.hidden = false;
}

function closeOverlay() {
  overlay.hidden = true;
  overlayPanel.innerHTML = '';
  state.detail = null;
  state.detailGroups = null;
  state.pendingCandidate = null;
}

/* ----------------------------------------------------------------- events */

document.addEventListener('click', async (event) => {
  const target = event.target;
  if (target === overlay) return closeOverlay();

  const action = target.closest('[data-action]')?.dataset.action;
  if (action === 'close') return closeOverlay();

  if (action === 'tab') {
    const tab = target.closest('[data-tab]');
    if (tab) selectTab(tab.dataset.tab);
    return undefined;
  }

  const card = target.closest('.card');
  if (card) return openDetail(Number(card.dataset.id));

  const continueCard = target.closest('.continue-card');
  if (continueCard) return openDetail(Number(continueCard.dataset.id));

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
      // Keep the cached detail in sync so a later re-render keeps the checkbox.
      const entry = [...state.detail.episodes, ...state.detail.missing, ...state.detail.extras].find(
        (candidate) => candidate.itemKey === itemKey
      );
      if (entry) entry.watched = watched;
      state.detail.progress = result.progress;
      state.detail.series.progress = result.progress;
      const series = state.items.find((item) => item.id === state.detail.series.id);
      if (series) series.progress = result.progress;
      updateProgressUi();
      // 继续观看 is derived from the watch marks, so it has to be refetched —
      // otherwise the strip keeps showing the episode that was just ticked off.
      await loadLibrary();
    } catch (error) {
      row.classList.toggle('is-watched', !watched);
      toast(`保存失败：${error.message}`, true);
    }
    return undefined;
  }

  if (action === 'play') {
    try {
      await playFile(target.dataset.file);
    } catch (error) {
      toast(`无法播放：${error.message}`, true);
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
      await loadLibrary();
      await openDetail(seriesId);
    } catch (error) {
      toast(`操作失败：${error.message}`, true);
    }
    return undefined;
  }

  if (action === 'rematch') openMatchDialog();
  return undefined;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !overlay.hidden) closeOverlay();
  if (event.key === '/' && overlay.hidden && document.activeElement?.id !== 'search') {
    event.preventDefault();
    $('search').focus();
  }
});

/**
 * Double-clicking an episode row plays it, so the hover-only ▶ button is a
 * shortcut rather than a requirement. The checkbox and the action buttons are
 * excluded — otherwise a double-click on the checkbox would toggle twice and
 * then also launch the player.
 */
document.addEventListener('dblclick', async (event) => {
  const row = event.target.closest('.ep-row');
  if (!row || !state.detail) return;
  if (event.target.closest('.ep-check, .ep-actions')) return;
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

$('navList').addEventListener('click', (event) => {
  const button = event.target.closest('.nav-item');
  if (!button) return;
  for (const node of document.querySelectorAll('.nav-item')) node.classList.remove('is-active');
  button.classList.add('is-active');
  state.filter = button.dataset.filter;
  renderContinue();
  renderGrid();
});

$('btnCollapse').addEventListener('click', () => setCollapsed(!isCollapsed()));
$('btnMode').addEventListener('click', () => applyMode(currentMode() === 'dark' ? 'light' : 'dark'));

// Coming back to the window should show the current state immediately instead
// of waiting for the next heartbeat.
window.addEventListener('focus', () => pollScan());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollScan();
});

let searchDebounce = null;
$('search').addEventListener('input', (event) => {
  const value = event.target.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.query = value;
    renderGrid();
  }, 140);
});

$('sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderGrid();
});

$('btnScan').addEventListener('click', startScan);
$('btnSettings').addEventListener('click', openSettings);

/* ------------------------------------------------------------------ start */

document.querySelector('[data-icon="scan"]').innerHTML = ICONS.scan;
document.querySelector('[data-icon="settings"]').innerHTML = ICONS.settings;
applyTheme(currentTheme());
applyMode(currentMode());
setCollapsed(readStore(STORE.collapsed) === '1');
renderNav();
loadAppearance();
connectScanStream();

loadLibrary()
  .then(() => pollScan())
  .catch((error) => {
    emptyState.hidden = false;
    emptyState.innerHTML = `<div>无法连接后端：${escapeHtml(error.message)}</div>`;
  });
