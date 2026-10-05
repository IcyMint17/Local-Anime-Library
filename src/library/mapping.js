/**
 * Keeps the local↔Bangumi episode number mapping in one place.
 */
import * as repo from '../db/repo.js';
import { detectEpisodeOffset } from './offset.js';
import { isMainEpisodeType } from '../meta/bangumi.js';

export function localEpisodeNumbers(db, seriesId) {
  return repo
    .listFiles(db, seriesId)
    .filter((file) => file.kind === 'episode' && file.ep_number != null)
    .map((file) => file.ep_number);
}

export function bangumiEpisodeNumbers(db, seriesId) {
  return repo
    .listEpisodes(db, seriesId)
    .filter((episode) => isMainEpisodeType(episode.type))
    .map((episode) => episode.number)
    .filter((number) => Number.isFinite(number));
}

/** Number of local episodes that land on a Bangumi episode with this offset. */
export function countMatched(local, bangumi, offset) {
  const set = new Set(bangumi);
  return local.filter((number) => set.has(resolveNumber(number, offset, set))).length;
}

/**
 * Maps a local episode number onto Bangumi's numbering.
 *
 * The offset is applied first. Only when it lands outside Bangumi's list do we
 * fall back to the number as-is — that is what makes a folder mixing per-season
 * numbering with an absolute one work: Re:Zero 第三季 holds 01..14 *and* a file
 * called 66END, where 66+50 is nonsense but 66 is exactly right.
 *
 * Applying the offset first also keeps a uniformly shifted folder intact
 * (无职转生 第二季 is numbered 0..12 while Bangumi starts at 1), which a plain
 * "trust the number if it exists" rule would break at episode 1.
 */
export function resolveNumber(localNumber, offset, bangumiNumbers) {
  const set = bangumiNumbers instanceof Set ? bangumiNumbers : new Set(bangumiNumbers ?? []);
  const shifted = localNumber + offset;
  if (set.has(shifted)) return shifted;
  if (set.has(localNumber)) return localNumber;
  return shifted;
}

/**
 * Pairs every local episode number with the Bangumi episode it belongs to.
 *
 * Main episodes win: 孤独摇滚！ has a main episode 1 *and* an SP numbered 1, and
 * the local file `[01]` is the episode. Only when no main episode matches do we
 * look in the specials' own numbering space, which is how 无职转生's `[24]` and
 * the 11.5 half episode are recognised.
 */
export function matchLocalToBangumi(localNumbers, episodes, offset, options = {}) {
  // The raw-number fallback is a heuristic for messy folders. A mapping the user
  // pinned by hand is applied literally, so it is switched off there.
  const { allowRawFallback = true } = options;
  const main = new Map();
  const extras = new Map();
  for (const episode of episodes) {
    if (isMainEpisodeType(episode.type)) main.set(episode.number, episode);
    else if (!extras.has(episode.number)) extras.set(episode.number, episode);
  }

  const pairs = new Map();
  for (const number of localNumbers) {
    const target = allowRawFallback
      ? resolveNumber(number, offset, new Set(main.keys()))
      : number + offset;
    if (main.has(target)) pairs.set(number, main.get(target));
    else if (allowRawFallback && extras.has(number)) pairs.set(number, extras.get(number));
  }
  return pairs;
}

export function mappingState(db, series) {
  const local = localEpisodeNumbers(db, series.id);
  const episodes = repo.listEpisodes(db, series.id);
  const bangumi = episodes.filter((episode) => isMainEpisodeType(episode.type));
  const offset = Number(series.ep_offset ?? 0) || 0;
  const pairs = matchLocalToBangumi(local, episodes, offset, {
    allowRawFallback: Number(series.ep_offset_auto ?? 1) === 1,
  });
  return {
    offset,
    auto: Number(series.ep_offset_auto ?? 1) === 1,
    localTotal: local.length,
    bangumiTotal: bangumi.length,
    matched: pairs.size,
    localMin: local.length ? Math.min(...local) : null,
    localMax: local.length ? Math.max(...local) : null,
    bangumiMin: bangumi.length ? Math.min(...bangumi.map((episode) => episode.number)) : null,
    bangumiMax: bangumi.length ? Math.max(...bangumi.map((episode) => episode.number)) : null,
  };
}

/**
 * Recomputes and stores the offset from the episode numbers themselves.
 * Callers must only use this when the user has not pinned a manual mapping.
 */
export function applyAutoOffset(db, series) {
  const result = detectEpisodeOffset(localEpisodeNumbers(db, series.id), bangumiEpisodeNumbers(db, series.id));
  repo.updateSeries(db, series.id, { ep_offset: result.offset, ep_offset_auto: 1 });
  return result;
}
