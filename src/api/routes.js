/**
 * HTTP API. Handlers only validate input and talk to the repository / scanner.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as repo from '../db/repo.js';
import { ensureCover } from '../meta/covers.js';
import { openWithDefaultPlayer } from '../playback/open.js';
import { computeProgress } from '../library/progress.js';
import { applyAutoOffset, mappingState } from '../library/mapping.js';
import { isValidOffset, MAX_OFFSET } from '../library/offset.js';

export const EPISODE_KEY = (number) => `ep:${number}`;
export const SPECIAL_KEY = (fileId) => `file:${fileId}`;
export const MOVIE_KEY = 'movie';

export function itemKeyFor(file) {
  if (file.kind === 'special') return SPECIAL_KEY(file.id);
  if (file.kind === 'movie') return MOVIE_KEY;
  if (file.ep_number != null) return EPISODE_KEY(file.ep_number);
  return `file:${file.id}`;
}

function seriesToJson(series, progress) {
  const { local_key: _ignored, ...rest } = series;
  return {
    ...rest,
    coverUrl: series.cover_path ? `/covers/${series.cover_path}` : series.cover_url ?? null,
    progress,
  };
}

function filesToJson(files) {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    path: file.path,
    dir: path.dirname(file.path),
    ext: file.ext,
    size: file.size,
    kind: file.kind,
    epNumber: file.ep_number,
    epLabel: file.ep_label,
  }));
}

/**
 * `openFile` is injectable so the playlist endpoints can be tested without
 * actually launching a media player on the machine running the tests.
 */
export function createRoutes({
  db,
  client,
  config,
  saveConfig,
  scanController,
  openFile = openWithDefaultPlayer,
}) {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      `^${pattern
        .split('/')
        .map((segment) => {
          if (segment.startsWith(':')) {
            keys.push(segment.slice(1));
            return '([^/]+)';
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/')}$`
    );
    routes.push({ method, regex, keys, handler });
  };

  /* ------------------------------------------------------------- library */

  add('GET', '/api/library', () => {
    const series = repo.listSeries(db);
    const items = series.map((row) => seriesToJson(row, computeProgress(db, row)));
    return {
      items,
      stats: {
        total: items.length,
        unmatched: items.filter((item) => item.match_state === 'unmatched').length,
        watching: items.filter((item) => item.progress.status === 'watching').length,
        completed: items.filter((item) => item.progress.status === 'completed').length,
      },
      lastScan: repo.lastScanRun(db),
    };
  });

  add('GET', '/api/series/:id', (params) => {
    const seriesId = Number(params.id);
    const series = repo.getSeries(db, seriesId);
    if (!series) return { status: 404, body: { error: 'not found' } };

    const files = repo.listFiles(db, seriesId);
    const marks = repo.listWatchMarks(db, seriesId);
    const watchedKeys = new Set(marks.filter((mark) => mark.watched).map((mark) => mark.item_key));
    const bangumiEpisodes = repo.listEpisodes(db, seriesId);
    const offset = Number(series.ep_offset ?? 0) || 0;

    const filesByEpisode = new Map();
    for (const file of files) {
      if (file.kind !== 'episode' || file.ep_number == null) continue;
      if (!filesByEpisode.has(file.ep_number)) filesByEpisode.set(file.ep_number, []);
      filesByEpisode.get(file.ep_number).push(file);
    }

    const localNumbers = [...filesByEpisode.keys()].sort((a, b) => a - b);
    const covered = new Set(localNumbers.map((number) => number + offset));

    const episodes = localNumbers.map((number) => {
      const bangumi = bangumiEpisodes.find((episode) => episode.number === number + offset) ?? null;
      const itemKey = EPISODE_KEY(number);
      return {
        number,
        itemKey,
        inLibrary: true,
        title: bangumi?.title_cn || bangumi?.title || null,
        airDate: bangumi?.air_date ?? null,
        bangumiNumber: bangumi?.number ?? null,
        watched: watchedKeys.has(itemKey),
        files: filesToJson(filesByEpisode.get(number)),
      };
    });

    // Movie entries carry a single untitled episode, so listing "you are
    // missing episode 1" for a film the user actually owns is just noise.
    const trackMissing = bangumiEpisodes.length > 1 && series.media_kind !== 'movie' && series.media_kind !== 'special';
    const missing = trackMissing
      ? bangumiEpisodes
          .filter((episode) => !covered.has(episode.number))
          .map((episode) => ({
            number: episode.number,
            itemKey: EPISODE_KEY(episode.number),
            inLibrary: false,
            title: episode.title_cn || episode.title || null,
            airDate: episode.air_date,
            bangumiNumber: episode.number,
            watched: watchedKeys.has(EPISODE_KEY(episode.number)),
            files: [],
          }))
      : [];

    const extras = files
      .filter((file) => file.kind !== 'episode')
      .map((file) => {
        const itemKey = itemKeyFor(file);
        return {
          id: file.id,
          itemKey,
          kind: file.kind,
          title: file.name,
          watched: watchedKeys.has(itemKey),
          files: filesToJson([file]),
        };
      });

    return {
      series: seriesToJson(series, computeProgress(db, series)),
      progress: computeProgress(db, series),
      episodes,
      missing,
      extras,
      mapping: mappingState(db, series),
      episodeOffset: offset,
      counts: {
        files: files.length,
        episodes: localNumbers.length,
        specials: extras.filter((item) => item.kind === 'special').length,
        movies: extras.filter((item) => item.kind === 'movie').length,
        missingEpisodes: missing.length,
      },
      sourceFolder: series.source_folder,
    };
  });

  /* ---------------------------------------------------------- watch state */

  add('POST', '/api/series/:id/watch', (params, body) => {
    const seriesId = Number(params.id);
    const series = repo.getSeries(db, seriesId);
    if (!series) return { status: 404, body: { error: 'not found' } };
    const itemKey = String(body.itemKey ?? '');
    if (!itemKey) return { status: 400, body: { error: 'itemKey is required' } };
    repo.setWatchMark(db, seriesId, itemKey, Boolean(body.watched));
    return { ok: true, progress: computeProgress(db, series) };
  });

  add('POST', '/api/series/:id/watch-all', (params, body) => {
    const seriesId = Number(params.id);
    const series = repo.getSeries(db, seriesId);
    if (!series) return { status: 404, body: { error: 'not found' } };
    const watched = body.watched !== false;
    for (const file of repo.listFiles(db, seriesId)) {
      if (file.kind === 'episode' && file.ep_number != null) {
        repo.setWatchMark(db, seriesId, EPISODE_KEY(file.ep_number), watched);
      } else {
        repo.setWatchMark(db, seriesId, itemKeyFor(file), watched);
      }
    }
    if (!watched) {
      for (const episode of repo.listEpisodes(db, seriesId)) {
        repo.setWatchMark(db, seriesId, EPISODE_KEY(episode.number), false);
      }
    }
    return { ok: true, progress: computeProgress(db, series) };
  });

  /* ------------------------------------------------------------- matching */

  add('GET', '/api/series/:id/candidates', (params) => {
    const candidates = repo.listCandidates(db, Number(params.id));
    return {
      candidates: candidates.map((candidate) => ({
        bangumiId: candidate.id,
        title: candidate.name_cn || candidate.name,
        original: candidate.name,
        date: candidate.date ?? null,
        eps: candidate.eps ?? null,
        score: candidate.score,
        cover: candidate.images?.large ?? candidate.images?.common ?? candidate.images?.grid ?? null,
      })),
    };
  });

  add('GET', '/api/search', async (_params, _body, query) => {
    const keyword = String(query.get('q') ?? '').trim();
    if (!keyword) return { candidates: [] };
    const hits = await client.searchSubjects(keyword, { limit: 12, useCache: false });
    return {
      candidates: hits.map((hit) => ({
        bangumiId: hit.id,
        title: hit.name_cn || hit.name,
        original: hit.name,
        date: hit.date ?? null,
        eps: hit.eps ?? null,
        score: null,
        cover: hit.images?.large ?? hit.images?.common ?? hit.images?.grid ?? null,
      })),
    };
  });

  add('POST', '/api/series/:id/match', async (params, body) => {
    const seriesId = Number(params.id);
    const series = repo.getSeries(db, seriesId);
    if (!series) return { status: 404, body: { error: 'not found' } };
    const bangumiId = Number(body.bangumiId);
    if (!Number.isFinite(bangumiId)) return { status: 400, body: { error: 'bangumiId is required' } };

    // Either an explicit "local N = Bangumi M" pair, a raw offset, or nothing
    // at all — in which case the mapping is inferred from the episode numbers.
    const wantsManual =
      Number.isFinite(Number(body.localNumber)) && Number.isFinite(Number(body.bangumiNumber));
    const manualOffset = wantsManual
      ? Number(body.bangumiNumber) - Number(body.localNumber)
      : Number.isFinite(Number(body.epOffset))
        ? Number(body.epOffset)
        : 0;
    if (wantsManual && !isValidOffset(manualOffset)) {
      return { status: 400, body: { error: `集号偏移超出范围（±${MAX_OFFSET}）` } };
    }

    const subject = await client.getSubject(bangumiId, { useCache: false });
    repo.updateSeries(db, seriesId, {
      bangumi_id: bangumiId,
      title_cn: subject.name_cn || subject.name,
      title_orig: subject.name ?? null,
      summary: subject.summary ?? null,
      air_date: subject.date ?? null,
      eps_total: Number.isFinite(subject.eps) && subject.eps > 0 ? subject.eps : null,
      cover_url: subject.images?.large ?? subject.images?.common ?? subject.images?.grid ?? null,
      rating: subject.rating?.score ?? null,
      rating_count: subject.rating?.total ?? null,
      ep_offset: wantsManual ? manualOffset : 0,
      ep_offset_auto: wantsManual ? 0 : 1,
      match_state: 'manual',
      match_score: 1,
    });

    try {
      repo.replaceEpisodes(db, seriesId, await client.getEpisodes(bangumiId, { useCache: false }));
    } catch (error) {
      client.logger?.warn?.(`获取剧集列表失败: ${error.message}`);
    }
    if (!wantsManual) applyAutoOffset(db, repo.getSeries(db, seriesId));
    const cover = await ensureCover({
      subject,
      coversDir: config.coversDir,
      proxy: client.proxy,
      userAgent: client.userAgent,
    });
    if (cover) repo.updateSeries(db, seriesId, { cover_path: path.basename(cover) });

    const updated = repo.getSeries(db, seriesId);
    return {
      ok: true,
      series: seriesToJson(updated, computeProgress(db, updated)),
      mapping: mappingState(db, updated),
    };
  });

  /** Change the local↔Bangumi episode mapping without re-binding the subject. */
  add('POST', '/api/series/:id/offset', (params, body) => {
    const seriesId = Number(params.id);
    const series = repo.getSeries(db, seriesId);
    if (!series) return { status: 404, body: { error: 'not found' } };

    if (body.mode === 'auto' || body.auto === true) {
      applyAutoOffset(db, series);
      return { ok: true, mapping: mappingState(db, repo.getSeries(db, seriesId)) };
    }

    let offset;
    if (Number.isFinite(Number(body.localNumber)) && Number.isFinite(Number(body.bangumiNumber))) {
      offset = Number(body.bangumiNumber) - Number(body.localNumber);
    } else if (Number.isFinite(Number(body.offset))) {
      offset = Number(body.offset);
    }
    if (!isValidOffset(offset)) {
      return { status: 400, body: { error: `集号偏移超出范围（±${MAX_OFFSET}）` } };
    }

    repo.updateSeries(db, seriesId, { ep_offset: offset, ep_offset_auto: 0 });
    return { ok: true, mapping: mappingState(db, repo.getSeries(db, seriesId)) };
  });

  add('POST', '/api/series/:id/unmatch', (params) => {
    const seriesId = Number(params.id);
    const series = repo.getSeries(db, seriesId);
    if (!series) return { status: 404, body: { error: 'not found' } };
    repo.updateSeries(db, seriesId, {
      bangumi_id: null,
      title_cn: series.source_folder,
      title_orig: null,
      summary: null,
      air_date: null,
      eps_total: null,
      cover_url: null,
      cover_path: null,
      rating: null,
      rating_count: null,
      ep_offset: 0,
      ep_offset_auto: 1,
      match_state: 'unmatched',
      match_score: null,
    });
    repo.replaceEpisodes(db, seriesId, []);
    return { ok: true };
  });

  /* ------------------------------------------------------------- playback */

  add('POST', '/api/files/:id/play', (params) => {
    const file = repo.getFile(db, Number(params.id));
    if (!file) return { status: 404, body: { error: 'not found' } };
    if (!fs.existsSync(file.path)) return { status: 410, body: { error: '文件已不存在', path: file.path } };
    openFile(file.path);
    return { ok: true, path: file.path };
  });

  /* ----------------------------------------------------------------- scan */

  add('POST', '/api/scan', () => {
    if (scanController.isRunning()) return { started: false, reason: '扫描进行中' };
    scanController.start().catch(() => {});
    return { started: true };
  });

  add('GET', '/api/scan/status', () => scanController.status());

  /* ------------------------------------------------------------- settings */

  add('GET', '/api/settings', () => ({
    scanDirs: config.scan.dirs,
    proxy: config.proxy,
    resolvedProxy: config.resolvedProxy,
    requestIntervalMs: config.metadata.requestIntervalMs,
    matchThreshold: config.metadata.matchThreshold,
    matchMargin: config.metadata.matchMargin,
    port: config.server.port,
    seriesCount: repo.listSeries(db).length,
  }));

  add('PUT', '/api/settings', (_params, body) => {
    const patch = {};
    if (Array.isArray(body.scanDirs)) patch.scan = { dirs: body.scanDirs.map(String).filter(Boolean) };
    if (typeof body.proxy === 'string') patch.proxy = body.proxy.trim();
    if (Number.isFinite(Number(body.matchThreshold))) {
      patch.metadata = { matchThreshold: Math.max(0.3, Math.min(0.95, Number(body.matchThreshold))) };
    }
    if (Number.isFinite(Number(body.matchMargin))) {
      patch.metadata = { ...(patch.metadata ?? {}), matchMargin: Math.max(0, Math.min(0.5, Number(body.matchMargin))) };
    }
    if (Number.isFinite(Number(body.requestIntervalMs))) {
      patch.metadata = { ...(patch.metadata ?? {}), requestIntervalMs: Math.max(200, Number(body.requestIntervalMs)) };
    }
    const saved = saveConfig(patch);
    Object.assign(config, saved);
    return { ok: true };
  });

  return { routes };
}

export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.regex.exec(pathname);
    if (!match) continue;
    const params = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { route, params };
  }
  return null;
}
