/**
 * A single local folder often covers several Bangumi entries: 无职转生
 * ～到了异世界就拿出真本事～ holds 第1部分 (sort 1–11) *and* 第2部分 (sort 12–23
 * plus an SP at 24) in one directory. This module merges those entries so the
 * episode list, the numbering and the SP classification all line up.
 */
import * as repo from '../db/repo.js';
import { detectEpisodeOffset } from './offset.js';
import { matchLocalToBangumi } from './mapping.js';
import { isMainEpisodeType } from '../meta/bangumi.js';

export const tagEpisodes = (episodes, bangumiId) =>
  episodes.map((episode) => ({ ...episode, bangumi_id: bangumiId }));

const coveredNumbers = (episodes) => new Set(episodes.map((episode) => episode.number));

/** Every local episode number, including files already known to be extras. */
export function allLocalNumbers(db, seriesId) {
  return repo
    .listFiles(db, seriesId)
    .filter((file) => file.ep_number != null)
    .map((file) => file.ep_number);
}

export function uncoveredNumbers(localNumbers, episodes, offset) {
  const covered = coveredNumbers(episodes);
  return [...new Set(localNumbers.map((number) => number + offset))].filter((number) => !covered.has(number));
}

function sortRange(episodes) {
  const numbers = episodes.map((episode) => episode.number).filter(Number.isFinite);
  if (!numbers.length) return null;
  return { min: Math.min(...numbers), max: Math.max(...numbers) };
}

/**
 * Looks for further Bangumi entries that cover local episode numbers the
 * primary entry does not. Only entries that actually fill a gap are attached.
 */
async function attachSiblingParts({ client, query, episodes, wanted, excluded, maxCandidates = 8, maxParts = 2 }) {
  const attached = [];
  const known = coveredNumbers(episodes);
  const takenIds = new Set(excluded);
  if (!query) return attached;

  for (let round = 0; round < maxParts; round += 1) {
    const missing = new Set(
      wanted.filter((number) => !known.has(number) && number >= Math.min(...wanted) && number <= Math.max(...wanted))
    );
    if (missing.size === 0) break;

    let hits = [];
    try {
      hits = await client.searchSubjects(query, { limit: 12 });
    } catch {
      break;
    }

    const currentRange = sortRange(episodes);
    let best = null;
    for (const subject of hits.slice(0, maxCandidates)) {
      if (takenIds.has(subject.id)) continue;
      let list = [];
      try {
        list = await client.getEpisodes(subject.id);
      } catch {
        continue;
      }
      if (!list.length) continue;

      const covered = list.filter((episode) => missing.has(episode.number)).length;
      if (covered === 0) continue;

      // Prefer entries that sit next to what we already have, so an unrelated
      // show that happens to share an episode number is not pulled in.
      const range = sortRange(list);
      const adjacent =
        !currentRange ||
        (range.min <= currentRange.max + 2 && range.max >= currentRange.min - 2);
      if (!adjacent) continue;

      if (!best || covered > best.covered) best = { subject, list, covered };
    }

    if (!best) break;
    takenIds.add(best.subject.id);
    best.list.forEach((episode) => known.add(episode.number));
    attached.push(best);
    episodes = episodes.concat(best.list);
  }

  return attached;
}

/**
 * Fetches every part a folder covers, keeps the episode list in sync, works out
 * the local↔Bangumi offset and re-classifies local files Bangumi marks as SP.
 */
export async function syncEpisodes({ db, client, series, query, logger = console }) {
  const primaryId = series.bangumi_id;
  const stored = repo.listSeriesSubjects(db, series.id);
  const partIds = [primaryId];
  for (const part of stored) {
    if (part.bangumi_id !== primaryId) partIds.push(part.bangumi_id);
  }

  let episodes = [];
  for (const id of partIds) {
    try {
      episodes = episodes.concat(tagEpisodes(await client.getEpisodes(id), id));
    } catch (error) {
      logger?.warn?.(`获取条目 ${id} 的剧集列表失败: ${error.message}`);
    }
  }
  if (episodes.length === 0) {
    return { offset: Number(series.ep_offset ?? 0) || 0, parts: partIds, addedParts: 0, reclassified: 0 };
  }

  const episodeLocal = repo
    .listFiles(db, series.id)
    .filter((file) => file.kind === 'episode' && file.ep_number != null)
    .map((file) => file.ep_number);
  const everyLocal = allLocalNumbers(db, series.id);

  const auto = Number(series.ep_offset_auto ?? 1) === 1;
  let offset = Number(series.ep_offset ?? 0) || 0;
  if (auto) offset = detectEpisodeOffset(episodeLocal, episodes.map((e) => e.number)).offset;

  const wanted = uncoveredNumbers(everyLocal, episodes, offset);
  if (wanted.length > 0) {
    const extra = await attachSiblingParts({
      client,
      query,
      episodes,
      wanted,
      excluded: partIds,
    });
    if (extra.length > 0) {
      for (const part of extra) {
        episodes = episodes.concat(tagEpisodes(part.list, part.subject.id));
        partIds.push(part.subject.id);
      }
      if (auto) offset = detectEpisodeOffset(episodeLocal, episodes.map((e) => e.number)).offset;
    }
  }

  repo.replaceEpisodes(db, series.id, episodes);

  const parts = [];
  for (const id of partIds) {
    const list = episodes.filter((episode) => episode.bangumi_id === id);
    if (list.length === 0) continue;
    let subject = null;
    try {
      subject = await client.getSubject(id);
    } catch {
      subject = null;
    }
    parts.push({
      id,
      name_cn: subject?.name_cn ?? (id === primaryId ? series.title_cn : null),
      name: subject?.name ?? (id === primaryId ? series.title_orig : null),
      min: Math.min(...list.map((e) => e.number)),
      primary: id === primaryId,
    });
  }
  parts.sort((a, b) => a.min - b.min);
  repo.replaceSeriesSubjects(db, series.id, parts);

  repo.updateSeries(db, series.id, {
    ep_offset: offset,
    ep_offset_auto: auto ? 1 : 0,
    eps_total: parts.reduce((total, part) => {
      const list = episodes.filter((e) => e.bangumi_id === part.id && isMainEpisodeType(e.type));
      return total + list.length;
    }, 0) || series.eps_total,
  });

  const reclassified = reclassifyFromBangumi(db, series.id, offset);
  return { offset, parts, addedParts: partIds.length - 1, reclassified };
}

/**
 * Bangumi is authoritative about what is a main episode: a local file that maps
 * onto an SP entry is demoted to 特别篇. The reverse is deliberately not done —
 * "歌曲欣赏 01" also carries the number 1 and must not be promoted.
 */
export function reclassifyFromBangumi(db, targetSeriesId, offset) {
  const episodes = repo.listEpisodes(db, targetSeriesId);
  const files = repo.listFiles(db, targetSeriesId);
  const series = repo.getSeries(db, targetSeriesId);
  const pairs = matchLocalToBangumi(
    files.filter((file) => file.ep_number != null).map((file) => file.ep_number),
    episodes,
    offset,
    { allowRawFallback: Number(series?.ep_offset_auto ?? 1) === 1 }
  );

  let changed = 0;
  for (const file of files) {
    if (file.kind !== 'episode' || file.ep_number == null) continue;
    const episode = pairs.get(file.ep_number);
    if (!episode || isMainEpisodeType(episode.type)) continue;
    repo.updateFileKind(db, file.id, 'special');
    changed += 1;
  }
  return changed;
}
