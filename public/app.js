/* 本地番剧媒体库管理器 — 前端（原生 JS，无构建步骤） */

const state = {
  items: [],
  stats: {},
  lastScan: null,
  filter: 'all',
  sort: 'recent',
  query: '',
  scan: { running: false, progress: null, last: null },
  detail: null,
  detailTab: 'episodes',
  detailGroups: null,
  pendingCandidate: null,
};

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const emptyState = $('emptyState');
const overlay = $('overlay');
const overlayPanel = $('overlayPanel');

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
  state.stats = data.stats;
  state.lastScan = data.lastScan;
  renderCounts();
  renderGrid();
  renderBrandSub();
}

function renderBrandSub() {
  const { total, unmatched, watching, completed } = state.stats;
  const parts = [`共 ${total} 部`];
  if (watching) parts.push(`观看中 ${watching}`);
  if (completed) parts.push(`已看完 ${completed}`);
  if (unmatched) parts.push(`待确认 ${unmatched}`);
  if (state.lastScan?.finished_at) {
    parts.push(`上次扫描 ${new Date(state.lastScan.finished_at).toLocaleString('zh-CN', { hour12: false })}`);
  }
  $('brandSub').textContent = parts.join(' · ');
}

function renderCounts() {
  $('countAll').textContent = state.items.length;
  $('countUnmatched').textContent = state.items.filter((item) => item.match_state === 'unmatched').length;
  $('countNone').textContent = state.items.filter(
    (item) => item.progress.status === 'none' && item.match_state !== 'unmatched'
  ).length;
  $('countWatching').textContent = state.items.filter((item) => item.progress.status === 'watching').length;
  $('countCompleted').textContent = state.items.filter((item) => item.progress.status === 'completed').length;
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
  else if (progress.status !== 'none') {
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
                 <div class="source-meta">${escapeHtml(mappingMeta)}</div>
                 <button class="btn btn-small btn-ghost" data-action="edit-mapping">调整对应关系…</button>`
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
         <div class="field-hint">支持中文名、日文原名、罗马音。搜不到就换个关键词再试。</div>
       </div>
       <div class="field">
         <label>集号对应</label>
         <div class="field-hint">
           绑定后会自动推断本地集号和 Bangumi 集号的对应关系——例如本地从第 67 集开始、Bangumi 从第 1 集开始，或者本地有一个第 00 集。
           如果推断结果不对，可以在详情页的「集号对应」里手动调整。
         </div>
       </div>
       <div class="candidate-list" id="candidateList"><span class="spinner"></span></div>
     </div>
     <div class="dialog-foot">
       <button class="btn btn-ghost" data-action="close">取消</button>
       <button class="btn btn-primary" id="btnBind" disabled>绑定选中的条目</button>
     </div>`,
    { narrow: true }
  );

  const runSearch = async (keyword) => {
    const list = $('candidateList');
    list.innerHTML = '<span class="spinner"></span> 搜索中…';
    try {
      const data = keyword
        ? await api(`/api/search?q=${encodeURIComponent(keyword)}`)
        : await api(`/api/series/${series.id}/candidates`);
      state.pendingCandidate = null;
      $('btnBind').disabled = true;
      renderCandidates(list, data.candidates ?? []);
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
  $('btnBind').addEventListener('click', async () => {
    if (!state.pendingCandidate) return;
    const button = $('btnBind');
    button.disabled = true;
    button.textContent = '绑定中…';
    const seriesId = series.id;
    try {
      await api(`/api/series/${seriesId}/match`, {
        method: 'POST',
        body: { bangumiId: state.pendingCandidate },
      });
      await loadLibrary();
      await openDetail(seriesId);
      toast('已重新绑定');
    } catch (error) {
      toast(`绑定失败：${error.message}`, true);
      button.disabled = false;
      button.textContent = '绑定选中的条目';
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
        <div class="candidate" data-id="${candidate.bangumiId}">
          <div class="candidate-cover">${cover}</div>
          <div class="candidate-body">
            <div class="candidate-title">${escapeHtml(candidate.title ?? '')}</div>
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

/* -------------------------------------------------------- episode mapping */

function openMappingDialog() {
  const { series, mapping } = state.detail;
  const localMin = mapping?.localMin ?? 1;
  const bangumiForLocalMin = localMin + (mapping?.offset ?? 0);

  openOverlay(
    `<div class="dialog-head"><h3>集号对应关系</h3><button class="btn btn-small btn-ghost" data-action="close">关闭</button></div>
     <div class="dialog-body">
       <div class="field">
         <label class="check-row"><input type="checkbox" id="mapAuto" ${
           mapping?.auto ? 'checked' : ''
         } /> 自动推断（推荐）</label>
         <div class="field-hint">根据本地集号和 Bangumi 的剧集列表自动对齐。重新扫描时会重新计算：本地从第 67 集开始、Bangumi 从第 1 集开始这类情况都能自动认出来。</div>
       </div>
       <div class="field">
         <label>手动指定</label>
         <div class="mapping-inputs">
           <span>本地第</span>
           <input id="mapLocal" type="number" step="1" value="${localMin}" />
           <span>集 = Bangumi 第</span>
           <input id="mapBgm" type="number" step="1" value="${bangumiForLocalMin}" />
           <span>集</span>
         </div>
         <div class="field-hint" id="mapPreview"></div>
       </div>
     </div>
     <div class="dialog-foot">
       <button class="btn btn-ghost" data-action="close">取消</button>
       <button class="btn btn-primary" id="btnSaveMapping">保存</button>
     </div>`,
    { narrow: true }
  );

  const auto = $('mapAuto');
  const localInput = $('mapLocal');
  const bgmInput = $('mapBgm');

  const refresh = () => {
    const disabled = auto.checked;
    localInput.disabled = disabled;
    bgmInput.disabled = disabled;
    const local = Number(localInput.value);
    const bgm = Number(bgmInput.value);
    $('mapPreview').textContent = disabled
      ? '保存后会立刻按 Bangumi 剧集列表重新推断。'
      : Number.isFinite(local) && Number.isFinite(bgm)
        ? `即：本地集号 ${bgm - local >= 0 ? '+ ' : '− '}${Math.abs(bgm - local)} 后对应 Bangumi 集号。`
        : '请填写两个集号。';
  };
  auto.addEventListener('change', refresh);
  localInput.addEventListener('input', refresh);
  bgmInput.addEventListener('input', refresh);
  refresh();

  $('btnSaveMapping').addEventListener('click', async () => {
    const button = $('btnSaveMapping');
    const seriesId = series.id;
    const body = auto.checked
      ? { mode: 'auto' }
      : { mode: 'manual', localNumber: Number(localInput.value), bangumiNumber: Number(bgmInput.value) };
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      await api(`/api/series/${seriesId}/offset`, { method: 'POST', body });
      await openDetail(seriesId);
      toast(auto.checked ? '已重新自动推断集号对应' : '已保存手动指定的集号对应');
    } catch (error) {
      toast(`保存失败：${error.message}`, true);
      button.disabled = false;
      button.textContent = '保存';
    }
  });
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
function pollScan() {
  clearTimeout(pollTimer);
  const tick = async () => {
    let status;
    try {
      status = await api('/api/scan/status');
    } catch {
      pollTimer = setTimeout(tick, 3000);
      return;
    }
    const wasRunning = state.scan.running;
    state.scan = status;
    renderScanStatus();
    if (status.running) {
      pollTimer = setTimeout(tick, 1200);
      return;
    }
    if (wasRunning) {
      await loadLibrary();
      if (status.last) {
        toast(
          `扫描完成：${status.last.groups} 组，自动匹配 ${status.last.matched}，待确认 ${status.last.unmatched}`
        );
      }
    }
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
    button.textContent = '扫描';
    return;
  }
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> 扫描中';
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
      renderCounts();
      renderGrid();
      updateProgressUi();
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
  if (action === 'edit-mapping') openMappingDialog();
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

for (const button of document.querySelectorAll('.nav-item')) {
  button.addEventListener('click', () => {
    for (const node of document.querySelectorAll('.nav-item')) node.classList.remove('is-active');
    button.classList.add('is-active');
    state.filter = button.dataset.filter;
    renderGrid();
  });
}

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

loadLibrary()
  .then(() => pollScan())
  .catch((error) => {
    emptyState.hidden = false;
    emptyState.innerHTML = `<div>无法连接后端：${escapeHtml(error.message)}</div>`;
  });
