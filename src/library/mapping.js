/**
 * Keeps the local↔Bangumi episode number mapping in one place.
 */
import * as repo from '../db/repo.js';
import { detectEpisodeOffset } from './offset.js';

export function localEpisodeNumbers(db, seriesId) {
  return repo
    .listFiles(db, seriesId)
    .filter((file) => file.kind === 'episode' && file.ep_number != null)
    .map((file) => file.ep_number);
}

export function bangumiEpisodeNumbers(db, seriesId) {
  return repo
    .listEpisodes(db, seriesId)
    .map((episode) => episode.number)
    .filter((number) => Number.isFinite(number));
}

/** Number of local episodes that land on a Bangumi episode with this offset. */
export function countMatched(local, bangumi, offset) {
  const set = new Set(bangumi);
  return local.filter((number) => set.has(number + offset)).length;
}

export function mappingState(db, series) {
  const local = localEpisodeNumbers(db, series.id);
  const bangumi = bangumiEpisodeNumbers(db, series.id);
  const offset = Number(series.ep_offset ?? 0) || 0;
  return {
    offset,
    auto: Number(series.ep_offset_auto ?? 1) === 1,
    localTotal: local.length,
    bangumiTotal: bangumi.length,
    matched: countMatched(local, bangumi, offset),
    localMin: local.length ? Math.min(...local) : null,
    localMax: local.length ? Math.max(...local) : null,
    bangumiMin: bangumi.length ? Math.min(...bangumi) : null,
    bangumiMax: bangumi.length ? Math.max(...bangumi) : null,
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
