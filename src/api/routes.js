/**
 * HTTP API. Handlers only validate input and talk to the repository / scanner.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as repo from '../db/repo.js';
import { ensureCover } from '../meta/covers.js';
import { openWithDefaultPlayer } from '../playback/open.js';
import { computeProgress } from '../library/progress.js';
import { applyAutoOffset, mappingState, matchLocalToBangumi } from '../library/mapping.js';
import { isValidOffset, MAX_OFFSET } from '../library/offset.js';
import { syncEpisodes, reclassifyFromBangumi } from '../library/parts.js';
import { EPISODE_KEY, SPECIAL_KEY, MOVIE_KEY, itemKeyFor } from '../library/items.js';
import { isMainEpisodeType } from '../meta/bangumi.js';

export { EPISODE_KEY, SPECIAL_KEY, MOVIE_KEY, itemKeyFor };

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

/** The first not-yet-watched item of a series, for the 继续观看 strip. */
function nextUpFor(db, seriesId) {
  const series = repo.getSeries(db, seriesId);
  const files = repo.listFiles(db, seriesId);
  const watched = repo.watchedItemKeys(db, seriesId);
  const episodes = repo.listEpisodes(db, seriesId);
  const offset = Number(series?.ep_offset ?? 0) || 0;

  const pending = files
    .filter((file) => file.kind === 'episode' && file.ep_number != null)
    .sort((a, b) => a.ep_number - b.ep_number)
    .find((file) => !watched.has(EPISODE_KEY(file.ep_number)));

  if (!pending) {
    const extra = files.find((file) => !watched.has(itemKeyFor(file)));
    if (!extra) return { nextEpisode: null };
    return {
      nextEpisode: {
        number: null,
        fileId: extra.id,
        title: extra.name,
        kind: extra.kind,
        total: files.length,
        index: files.indexOf(extra) + 1,
      },
    };
  }

  const episode =
    matchLocalToBangumi([pending.ep_number], episodes, offset, {
      allowRawFallback: Number(series?.ep_offset_auto ?? 1) === 1,
    }).get(pending.ep_number) ?? null;
  return {
    nextEpisode: {
      number: pending.ep_number,
      fileId: pending.id,
      title: episode?.title_cn || episode?.title || null,
      kind: 'episode',
    },
  };
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
    const byId = new Map(items.map((item) => [item.id, item]));
    const recent = repo
      .recentWatchMarks(db, 6)
      .map((mark) => {
        const item = byId.get(mark.series_id);
        if (!item) return null;
        return {
          ...nextUpFor(db, mark.series_id),
          seriesId: item.id,
          title: item.title_cn,
          coverUrl: item.coverUrl,
          watchedAt: mark.watched_at,
          progress: item.progress,
          mediaKind: item.media_kind,
        };
      })
      .filter(Boolean);
    return {
      items,
      recent,
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
    const pairs = matchLocalToBangumi(localNumbers, bangumiEpisodes, offset, {
      allowRawFallback: Number(series.ep_offset_auto ?? 1) === 1,
    });
    const mainEpisodes = bangumiEpisodes.filter((episode) => isMainEpisodeType(episode.type));
    const covered = new Set([...pairs.values()].map((episode) => episode.number));

    const episodes = localNumbers.map((number) => {
      const bangumi = pairs.get(number) ?? null;
      const itemKey = EPISODE_KEY(number);
      return {
        number,
        itemKey,
        inLibrary: true,
        title: bangumi?.title_cn || bangumi?.title || null,
        airDate: bangumi?.air_date ?? null,
        bangumiNumber: bangumi?.number ?? null,
        bangumiEp: bangumi?.ep ?? null,
        type: bangumi?.type ?? null,
        partId: bangumi?.bangumi_id ?? null,
        watched: watchedKeys.has(itemKey),
        files: filesToJson(filesByEpisode.get(number)),
      };
    });

    // Movie entries carry a single untitled episode, so listing "you are
    // missing episode 1" for a film the user actually owns is just noise.
    const trackMissing = bangumiEpisodes.length > 1 && series.media_kind !== 'movie' && series.media_kind !== 'special';
    const missing = trackMissing
      ? mainEpisodes
          .filter((episode) => !covered.has(episode.number))
          .map((episode) => ({
            number: episode.number,
            itemKey: EPISODE_KEY(episode.number),
            inLibrary: false,
            title: episode.title_cn || episode.title || null,
            airDate: episode.air_date,
            bangumiNumber: episode.number,
            bangumiEp: episode.ep ?? null,
            type: episode.type ?? 0,
            partId: episode.bangumi_id ?? null,
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
      parts: repo.listSeriesSubjects(db, seriesId).map((part) => ({
        bangumiId: part.bangumi_id,
        title: part.title_cn || part.title_orig,
        primary: part.primary_part === 1,
      })),
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

    // A different subject invalidates any previously attached parts.
    repo.replaceSeriesSubjects(db, seriesId, []);
    try {
      await syncEpisodes({
        db,
        client,
        series: repo.getSeries(db, seriesId),
        query: series.source_folder,
        logger: client.logger,
      });
    } catch (error) {
      client.logger?.warn?.(`同步剧集列表失败: ${error.message}`);
    }
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
      const refreshed = repo.getSeries(db, seriesId);
      reclassifyFromBangumi(db, seriesId, Number(refreshed.ep_offset ?? 0) || 0);
      return { ok: true, mapping: mappingState(db, refreshed) };
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
    // A different numbering can change which local files Bangumi considers SP.
    reclassifyFromBangumi(db, seriesId, offset);
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

  add('GET', '/api/appearance', () => {
    const appearance = config.appearance ?? {};
    const file = appearance.background && config.dataDir ? path.join(config.dataDir, appearance.background) : null;
    const hasImage = Boolean(file) && fs.existsSync(file);
    return {
      hasImage,
      // The stored file name never changes, so bust the cache with its mtime.
      url: hasImage ? `/background?v=${Math.round(fs.statSync(file).mtimeMs)}` : null,
      blur: Number(appearance.blur ?? 0),
      brightness: Number(appearance.brightness ?? 1),
    };
  });

  add('POST', '/api/appearance', (_params, body) => {
    const appearance = { ...(config.appearance ?? {}) };
    const BACKGROUND_NAMES = ['background.jpg', 'background.png', 'background.webp', 'background.gif'];

    if (body.clear) {
      for (const name of BACKGROUND_NAMES) {
        const stale = path.join(config.dataDir, name);
        if (fs.existsSync(stale)) {
          try {
            fs.rmSync(stale, { force: true });
          } catch {
            /* a locked file is fine — clearing the setting is what matters */
          }
        }
      }
      appearance.background = null;
    } else if (typeof body.image === 'string') {
      const match = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(body.image);
      if (!match) return { status: 400, body: { error: '只接受 data:image/... 形式的图片' } };
      const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].replace(/[^a-z0-9]/gi, '');
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length === 0) return { status: 400, body: { error: '图片内容为空' } };
      if (buffer.length > 16 * 1024 * 1024) {
        return { status: 400, body: { error: '图片过大（上限 16 MB）' } };
      }

      const target = `background.${extension}`;
      for (const name of BACKGROUND_NAMES) {
        if (name === target) continue;
        const stale = path.join(config.dataDir, name);
        if (fs.existsSync(stale)) {
          try {
            fs.rmSync(stale, { force: true });
          } catch {
            /* ignore */
          }
        }
      }
      fs.writeFileSync(path.join(config.dataDir, target), buffer);
      appearance.background = target;
    }

    if (Number.isFinite(Number(body.blur))) appearance.blur = Math.max(0, Math.min(40, Number(body.blur)));
    if (Number.isFinite(Number(body.brightness))) {
      appearance.brightness = Math.max(0.2, Math.min(2, Number(body.brightness)));
    }

    config.appearance = appearance;
    saveConfig({ appearance });

    const file = appearance.background ? path.join(config.dataDir, appearance.background) : null;
    const hasImage = Boolean(file) && fs.existsSync(file);
    return {
      ok: true,
      hasImage,
      url: hasImage ? `/background?v=${Math.round(fs.statSync(file).mtimeMs)}` : null,
      blur: appearance.blur ?? 0,
      brightness: appearance.brightness ?? 1,
    };
  });

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
