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
import { similarity } from '../scan/parse.js';

/**
 * A sibling part is only legitimate when its title still belongs to the same
 * franchise as the folder. Without this check a search hit that merely fills
 * missing episode numbers (the next show in the library, for example) would be
 * merged in and its episodes would show up as "未收录".
 */
export function sameFranchise(series, candidate, threshold = 0.55) {
  const local = [series.title_cn, series.title_orig, series.source_folder].filter(Boolean);
  const remote = [
    candidate.title_cn ?? candidate.name_cn,
    candidate.title_orig ?? candidate.name,
  ].filter(Boolean);
  if (local.length === 0) return true;
  if (remote.length === 0) return false;
  let best = 0;
  for (const left of local) {
    for (const right of remote) best = Math.max(best, similarity(left, right));
  }
  return best >= threshold;
}

/**
 * Drops parts that were attached by an older, too-eager sibling merge. Called
 * at startup and before a sync, so the contaminated rows disappear from
 * existing databases without requiring a manual rescan.
 */
export function sanitizeSeriesParts(db, series) {
  const parts = repo.listSeriesSubjects(db, series.id);
  if (parts.length === 0) return 0;

  // Two guards: the title must belong to the same franchise, and the episode
  // range must touch what is already attached. The second one is what stops an
  // earlier season (0..25) from being merged into a folder numbered 51..66.
  const ranges = new Map();
  const numbersByPart = new Map();
  for (const episode of repo.listEpisodes(db, series.id)) {
    if (!Number.isFinite(Number(episode.number))) continue;
    const key = Number(episode.bangumi_id);
    const range = ranges.get(key) ?? { min: Infinity, max: -Infinity };
    range.min = Math.min(range.min, Number(episode.number));
    range.max = Math.max(range.max, Number(episode.number));
    ranges.set(key, range);
    if (!numbersByPart.has(key)) numbersByPart.set(key, new Set());
    numbersByPart.get(key).add(Number(episode.number));
  }

  // A sibling part is only worth keeping when at least one local file actually
  // lands on one of its episodes. Same-franchise seasons that merely sit next
  // to the primary range are still dropped if the folder never references them.
  const offset = Number(series.ep_offset ?? 0) || 0;
  const wanted = new Set(
    repo
      .listFiles(db, series.id)
      .filter((file) => file.kind === 'episode' && file.ep_number != null)
      .map((file) => Number(file.ep_number) + offset)
  );

  const primaryPart = parts.find((part) => part.bangumi_id === series.bangumi_id);
  const valid = [];
  const validIds = new Set();
  const keptNumbers = new Set(numbersByPart.get(series.bangumi_id) ?? []);
  let union = ranges.get(series.bangumi_id) ?? null;
  if (primaryPart) {
    valid.push(primaryPart);
    validIds.add(primaryPart.bangumi_id);
  }

  const candidates = parts
    .filter((part) => part.bangumi_id !== series.bangumi_id)
    .filter((part) => sameFranchise(series, part))
    .sort((a, b) => (ranges.get(a.bangumi_id)?.min ?? Infinity) - (ranges.get(b.bangumi_id)?.min ?? Infinity));

  for (const part of candidates) {
    const range = ranges.get(part.bangumi_id);
    const numbers = numbersByPart.get(part.bangumi_id);
    if (!range || !numbers) continue;
    if (union && (range.min > union.max + 2 || range.max < union.min - 2)) continue;
    if ([...numbers].filter((number) => keptNumbers.has(number)).length > 1) continue;
    if (![...numbers].some((number) => wanted.has(number))) continue;
    valid.push(part);
    validIds.add(part.bangumi_id);
    for (const number of numbers) keptNumbers.add(number);
    union = union
      ? { min: Math.min(union.min, range.min), max: Math.max(union.max, range.max) }
      : { ...range };
  }

  const staleEpisodes = [...ranges.keys()].some((id) => !validIds.has(id));
  if (valid.length === parts.length && !staleEpisodes) return 0;

  repo.replaceSeriesSubjects(
    db,
    series.id,
    valid.map((part) => ({
      id: part.bangumi_id,
      name_cn: part.title_cn,
      name: part.title_orig,
      primary: part.bangumi_id === series.bangumi_id,
    }))
  );
  const keep = new Set(validIds);
  keep.add(series.bangumi_id);
  repo.pruneEpisodes(db, series.id, keep);
  const total = repo
    .listEpisodes(db, series.id)
    .filter((episode) => isMainEpisodeType(episode.type)).length;
  if (total > 0) repo.updateSeries(db, series.id, { eps_total: total });
  return parts.length - valid.length;
}

/**
 * Recomputes the local↔Bangumi offset for auto series from the current rows.
 * After pruning a contaminated part the old offset can point at the wrong
 * numbering, so this runs once at startup as part of the cleanup.
 */
export function recalcAutoOffset(db, series) {
  if (Number(series.ep_offset_auto ?? 1) !== 1) return false;
  const local = repo
    .listFiles(db, series.id)
    .filter((file) => file.kind === 'episode' && file.ep_number != null)
    .map((file) => file.ep_number);
  const numbers = repo
    .listEpisodes(db, series.id)
    .filter((episode) => isMainEpisodeType(episode.type))
    .map((episode) => episode.number)
    .filter(Number.isFinite);
  if (local.length === 0 || numbers.length === 0) return false;
  const { offset } = detectEpisodeOffset(local, numbers);
  if (offset === (Number(series.ep_offset ?? 0) || 0)) return false;
  repo.updateSeries(db, series.id, { ep_offset: offset, ep_offset_auto: 1 });
  return true;
}

export function sanitizeAllParts(db) {
  let removed = 0;
  for (const series of repo.listSeries(db)) {
    removed += sanitizeSeriesParts(db, series);
    recalcAutoOffset(db, repo.getSeries(db, series.id));
  }
  return removed;
}

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
async function attachSiblingParts({ client, series, query, episodes, wanted, excluded, maxCandidates = 8, maxParts = 2 }) {
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
      if (!sameFranchise(series, { name_cn: subject.name_cn, name: subject.name })) continue;
      let list = [];
      try {
        list = await client.getEpisodes(subject.id);
      } catch {
        continue;
      }
      if (!list.length) continue;

      const covered = list.filter((episode) => missing.has(episode.number)).length;
      if (covered === 0) continue;
      if (list.filter((episode) => known.has(episode.number)).length > 1) continue;

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
  sanitizeSeriesParts(db, series);
  const stored = repo
    .listSeriesSubjects(db, series.id)
    .filter((part) => part.bangumi_id === primaryId || sameFranchise(series, part));
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
      series,
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
