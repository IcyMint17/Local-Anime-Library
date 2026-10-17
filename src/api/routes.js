/**
 * HTTP API. Handlers only validate input and talk to the repository / scanner.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as repo from '../db/repo.js';
import { ensureCover } from '../meta/covers.js';
import { openWithDefaultPlayer } from '../playback/open.js';
import { openFolder as openFolderInExplorer } from '../playback/reveal.js';
import { computeProgress, computeProgressAll } from '../library/progress.js';
import { applyAutoOffset, mappingState, matchLocalToBangumi } from '../library/mapping.js';
import { isValidOffset, MAX_OFFSET } from '../library/offset.js';
import { syncEpisodes, reclassifyFromBangumi } from '../library/parts.js';
import { EPISODE_KEY, SPECIAL_KEY, MOVIE_KEY, itemKeyFor } from '../library/items.js';
import { isMainEpisodeType, BangumiClient } from '../meta/bangumi.js';

export { EPISODE_KEY, SPECIAL_KEY, MOVIE_KEY, itemKeyFor };

function seriesToJson(series, progress) {
  const { local_key: _ignored, ...rest } = series;
  return {
    ...rest,
    favorite: Boolean(series.favorite),
    coverUrl: series.cover_path ? `/covers/${series.cover_path}` : series.cover_url ?? null,
    progress,
  };
}

const coverUrlOf = (row) => (row.cover_path ? `/covers/${row.cover_path}` : row.cover_url ?? null);

const ymd = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

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
 * `openFile` / `revealFolder` are injectable so the playback and folder
 * endpoints can be tested without actually launching apps on the machine
 * running the tests.
 */
export function createRoutes({
  db,
  client,
  config,
  saveConfig,
  scanController,
  openFile = openWithDefaultPlayer,
  revealFolder = openFolderInExplorer,
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
    // One batched pass instead of two queries per series.
    const progressById = computeProgressAll(db, series);
    const items = series.map((row) => seriesToJson(row, progressById.get(row.id)));
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

  /* ------------------------------------------------------------ timeline */

  /**
   * The timeline's raw material: recent watch ticks, the next week's air dates
   * and the latest additions. Everything is joined here rather than issuing a
   * query per event, so the page loads in one round-trip.
   */
  add('GET', '/api/timeline', (_params, _body, _query) => {
    const series = repo.listSeries(db);
    const byId = new Map(series.map((row) => [row.id, row]));

    const episodesBySeries = new Map();
    for (const episode of repo.allEpisodes(db)) {
      if (!episodesBySeries.has(episode.series_id)) episodesBySeries.set(episode.series_id, []);
      episodesBySeries.get(episode.series_id).push(episode);
    }

    const filesById = new Map();
    const episodeFile = new Map();
    for (const file of repo.allFiles(db)) {
      filesById.set(file.id, file);
      if (file.kind === 'episode' && file.ep_number != null) {
        episodeFile.set(`${file.series_id}:${file.ep_number}`, file);
      }
    }

    const events = repo
      .recentWatchEvents(db, 80)
      .map((row) => {
        const item = byId.get(row.series_id);
        if (!item) return null;
        const itemKey = row.item_key;
        let number = null;
        let label = '';
        let episodeTitle = null;
        let kind = row.media_kind ?? 'episode';
        let file = null;

        if (itemKey.startsWith('ep:')) {
          number = Number(itemKey.slice(3));
          const episodes = episodesBySeries.get(row.series_id) ?? [];
          const offset = Number(row.ep_offset ?? 0) || 0;
          const episode =
            matchLocalToBangumi([number], episodes, offset, {
              allowRawFallback: Number(item.ep_offset_auto ?? 1) === 1,
            }).get(number) ?? null;
          episodeTitle = episode?.title_cn || episode?.title || null;
          label = `第 ${number} 集`;
          file = episodeFile.get(`${row.series_id}:${number}`) ?? null;
        } else if (itemKey === 'movie') {
          label = '剧场版';
          kind = 'movie';
        } else if (itemKey.startsWith('file:')) {
          file = filesById.get(Number(itemKey.slice(5))) ?? null;
          kind = file?.kind ?? 'special';
          label = kind === 'movie' ? '剧场版' : '特别篇';
          episodeTitle = file?.ep_label ? `#${file.ep_label}` : file?.name ?? null;
        }

        return {
          seriesId: row.series_id,
          title: row.title_cn || row.title_orig || item.source_folder,
          coverUrl: coverUrlOf(item),
          itemKey,
          number,
          label,
          episodeTitle,
          kind,
          fileId: file?.id ?? null,
          downloaded: Boolean(file) && fs.existsSync(file.path),
          watchedAt: row.watched_at,
        };
      })
      .filter(Boolean);

    const today = new Date();
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const upcoming = repo.upcomingEpisodes(db, ymd(today), ymd(weekEnd)).map((row) => ({
      seriesId: row.series_id,
      title: row.series_title || row.title,
      coverUrl: coverUrlOf(row),
      number: row.number,
      episodeTitle: row.title_cn || row.title || null,
      airDate: row.air_date,
      mediaKind: row.media_kind,
    }));

    const additions = [...series]
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, 8)
      .map((row) => ({
        id: row.id,
        title: row.title_cn || row.title_orig || row.source_folder,
        coverUrl: coverUrlOf(row),
        createdAt: row.created_at,
        mediaKind: row.media_kind,
        rating: row.rating,
      }));

    return { events, upcoming, additions };
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

    // A file the parser could not give an episode number to has to stay
    // reachable. It is neither a numbered episode nor a recognised extra, and
    // filtering on `kind !== 'episode'` alone used to drop it from both lists —
    // so a folder like 小林家的龙女仆 怕寂寞的龙 showed a title and no file.
    const extras = files
      .filter((file) => file.kind !== 'episode' || file.ep_number == null)
      .map((file) => {
        const itemKey = itemKeyFor(file);
        return {
          id: file.id,
          itemKey,
          kind: file.kind === 'episode' ? 'special' : file.kind,
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


  /**
   * Rich Bangumi metadata for the detail sidebar: rating distribution,
   * collection counts, tags, characters, staff and a few short comments.
   *
   * This is a separate endpoint because it needs four rate-limited API calls;
   * the detail response itself must stay instant. Results are cached in the
   * same meta cache as everything else, so repeat opens are free.
   */
  add('GET', '/api/series/:id/extras', async (params) => {
    const series = repo.getSeries(db, Number(params.id));
    if (!series) return { status: 404, body: { error: 'not found' } };
    if (!series.bangumi_id) return { available: false, reason: 'unmatched' };

    const cacheKey = `subject-extras:v1:${series.bangumi_id}`;
    const cached = repo.getCache(db, cacheKey);
    if (cached?.value) return cached.value;

    const subjectId = series.bangumi_id;
    const results = await Promise.allSettled([
      client.getSubject(subjectId, { useCache: true }),
      client.getSubjectCharacters(subjectId),
      client.getSubjectPersons(subjectId),
    ]);
    if (results[0].status !== 'fulfilled') {
      return { available: false, error: results[0].reason?.message ?? '无法获取 Bangumi 详情' };
    }

    const subject = results[0].value ?? {};
    const characters = results[1].status === 'fulfilled' ? results[1].value ?? [] : [];
    const persons = results[2].status === 'fulfilled' ? results[2].value ?? [] : [];
    const ratingCounts = subject.rating?.count ?? {};

    // The infobox carries the production credits in a stable, human-readable
    // order; the persons endpoint is only a fallback for subjects that lack it.
    const infobox = Array.isArray(subject.infobox) ? subject.infobox : [];
    const infoboxValue = (value) =>
      Array.isArray(value)
        ? value.map((entry) => (typeof entry === 'object' ? entry?.v : entry)).filter(Boolean).join(' / ')
        : String(value ?? '').trim();
    const CREDITS = [
      ['动画制作', /^动画制作$/],
      ['制作', /^(制作|製作)$/],
      ['导演', /^(导演|监督)$/],
      ['原作', /^原作$/],
      ['音乐', /^(音乐|音楽)$/],
      ['系列构成', /^系列构成$/],
      ['人物设定', /^(人物设定|角色设计)$/],
      ['美术监督', /^美术监督$/],
      ['色彩设计', /^(色彩设计|色彩指定)$/],
      ['摄影监督', /^摄影监督$/],
      ['音响监督', /^(音响监督|音响)$/],
      ['剪辑', /^剪辑$/],
    ];
    const staff = [];
    for (const [label, pattern] of CREDITS) {
      const item = infobox.find((entry) => pattern.test(String(entry?.key ?? '')));
      const value = item ? infoboxValue(item.value) : '';
      if (value) staff.push({ id: null, name: value, relation: label, image: null });
    }
    if (staff.length === 0) {
      const seen = new Set();
      for (const person of persons) {
        if (!person?.name || seen.has(person.id)) continue;
        seen.add(person.id);
        staff.push({
          id: person.id,
          name: person.name,
          relation: person.relation ?? '制作',
          image: person.image ?? person.images?.small ?? person.images?.grid ?? null,
        });
      }
    }

    const payload = {
      available: true,
      rating: {
        score: subject.rating?.score ?? null,
        rank: subject.rating?.rank ?? null,
        total: subject.rating?.total ?? null,
        distribution: Array.from({ length: 10 }, (_, index) => ({
          score: index + 1,
          count: Number(ratingCounts[String(index + 1)] ?? 0),
        })),
      },
      collection: {
        wish: Number(subject.collection?.wish ?? 0),
        collect: Number(subject.collection?.collect ?? 0),
        doing: Number(subject.collection?.doing ?? 0),
        onHold: Number(subject.collection?.on_hold ?? 0),
        dropped: Number(subject.collection?.dropped ?? 0),
      },
      tags: Array.isArray(subject.tags)
        ? subject.tags.slice(0, 12).map((tag) => ({ name: tag.name, count: tag.count ?? 0 }))
        : [],
      info: {
        airDate: subject.date ?? null,
        eps: subject.eps ?? null,
        platform: subject.platform ?? null,
        aliases: BangumiClient.extractAliases(subject),
      },
      characters: characters.slice(0, 12).map((character) => ({
        id: character.id,
        name: character.name ?? '',
        relation: character.relation ?? '',
        image: character.image ?? character.images?.small ?? character.images?.grid ?? character.images?.medium ?? null,
        actors: (character.actors ?? []).map((actor) => ({
          name: actor.name ?? '',
          image: actor.image ?? actor.images?.small ?? actor.images?.grid ?? null,
        })),
      })),
      staff: staff.slice(0, 12),
    };

    // A partial failure is not cached, so the next open can fill the gaps.
    if (results.every((result) => result.status === 'fulfilled')) {
      repo.setCache(db, cacheKey, payload);
    }
    return payload;
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

  add('POST', '/api/series/:id/favorite', (params, body) => {
    const seriesId = Number(params.id);
    const series = repo.getSeries(db, seriesId);
    if (!series) return { status: 404, body: { error: 'not found' } };
    const favorite = Boolean(body.favorite);
    repo.setFavorite(db, seriesId, favorite);
    return { ok: true, favorite };
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
        // A candidate list shows thumbnails, and "large" is ~900 KB. Pulling
        // twelve of those per search was what filled the profile's disk cache.
        cover:
          hit.images?.common ??
          hit.images?.medium ??
          hit.images?.small ??
          hit.images?.grid ??
          null,
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

  /**
   * Opens the folder a series lives in. The scanner only stores the leaf folder
   * name on the series row, so the real location comes from its files.
   */
  add('POST', '/api/series/:id/reveal', (params) => {
    const series = repo.getSeries(db, Number(params.id));
    if (!series) return { status: 404, body: { error: 'not found' } };
    const file = repo
      .listFiles(db, series.id)
      .find((row) => row.path && fs.existsSync(row.path));
    if (!file) return { status: 410, body: { error: '番剧文件夹不存在或所有文件都已移动' } };
    const folder = path.dirname(file.path);
    revealFolder(folder);
    return { ok: true, folder };
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

  /* ---------------------------------------------------------- preferences */

  /**
   * Look-and-feel settings that have to outlive the page origin. The desktop
   * shell listens on a random port, so localStorage is empty on every launch —
   * these live in config.json instead.
   */
  add('GET', '/api/preferences', () => {
    const ui = config.ui ?? {};
    return {
      theme: ui.theme ?? null,
      mode: ui.mode === 'light' ? 'light' : 'dark',
      dock: ['left', 'right'].includes(ui.dock) ? ui.dock : 'bottom',
      glass: Number.isFinite(Number(ui.glass)) ? Math.max(0, Math.min(48, Number(ui.glass))) : 26,
      gpuAcceleration: ui.gpuAcceleration !== false,
      sidebarCollapsed: Boolean(ui.sidebarCollapsed),
    };
  });

  add('POST', '/api/preferences', (_params, body) => {
    const ui = { ...(config.ui ?? {}) };

    if (body.theme && typeof body.theme === 'object') {
      const accent = String(body.theme.accent ?? '').trim();
      const accent2 = String(body.theme.accent2 ?? '').trim() || accent;
      const isColour = (value) => /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value);
      if (!isColour(accent) || !isColour(accent2)) {
        return { status: 400, body: { error: '颜色需要是 #rrggbb 形式' } };
      }
      ui.theme = {
        id: String(body.theme.id ?? 'custom'),
        label: String(body.theme.label ?? '自定义'),
        accent,
        accent2,
      };
    }
    if (body.mode === 'light' || body.mode === 'dark') ui.mode = body.mode;
    if (['left', 'bottom', 'right'].includes(body.dock)) ui.dock = body.dock;
    if (Number.isFinite(Number(body.glass))) {
      ui.glass = Math.max(0, Math.min(48, Number(body.glass)));
    }
    if (typeof body.gpuAcceleration === 'boolean') ui.gpuAcceleration = body.gpuAcceleration;
    if (typeof body.sidebarCollapsed === 'boolean') ui.sidebarCollapsed = body.sidebarCollapsed;

    config.ui = ui;
    saveConfig({ ui });
    return { ok: true, ...ui };
  });

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
