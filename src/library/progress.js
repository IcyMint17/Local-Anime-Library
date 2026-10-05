/**
 * Watch state is derived, never stored. This keeps "已看 / 未看 / 观看中"
 * impossible to get out of sync with the per-episode checkboxes.
 */
import * as repo from '../db/repo.js';
import { EPISODE_KEY, itemKeyFor } from './items.js';

/** Pure calculation — the database access lives in the two wrappers below. */
export function progressFrom(files, watchedKeys, series) {
  const episodeFiles = files.filter((file) => file.kind === 'episode' && file.ep_number != null);
  const numbers = [...new Set(episodeFiles.map((file) => file.ep_number))].sort((a, b) => a - b);
  const localTotal = numbers.length;
  const specials = files.filter((file) => file.kind === 'special').length;
  const movies = files.filter((file) => file.kind === 'movie').length;

  // A film, or a disc that only holds extras, has no main episodes to count.
  // Tracking those by their own files is what lets 「全部已看」 actually reach
  // 已看完 instead of sitting on 未看 forever.
  if (localTotal === 0 && files.length > 0) {
    const watchedFiles = files.filter((file) => watchedKeys.has(itemKeyFor(file))).length;
    return {
      status: watchedFiles === 0 ? 'none' : watchedFiles >= files.length ? 'completed' : 'watching',
      watched: watchedFiles,
      total: files.length,
      localTotal: 0,
      percent: watchedFiles / files.length,
      specials,
      movies,
      totalFiles: files.length,
    };
  }

  // The denominator is "how many episodes you have to watch": at least what you
  // own, and at least what Bangumi lists. A folder that carries two cours of a
  // subject (无职转生 第二季 has 25 files for a 13-episode entry) must not read
  // as "25 / 13".
  const total = Math.max(series.eps_total ?? 0, localTotal);
  const watched = numbers.filter((number) => watchedKeys.has(EPISODE_KEY(number))).length;

  let status = 'none';
  if (watched > 0) {
    status = watched >= total ? 'completed' : 'watching';
  }

  return {
    status,
    watched,
    total,
    localTotal,
    percent: total > 0 ? Math.min(1, watched / total) : 0,
    specials,
    movies,
    totalFiles: files.length,
  };
}

export function computeProgress(db, series) {
  const files = repo.listFiles(db, series.id);
  const marks = repo.listWatchMarks(db, series.id);
  const watchedKeys = new Set(marks.filter((mark) => mark.watched).map((mark) => mark.item_key));
  return progressFrom(files, watchedKeys, series);
}

/**
 * Progress for every series using two queries total instead of two per series.
 * @returns {Map<number, object>} series id → progress
 */
export function computeProgressAll(db, allSeries) {
  const { filesBySeries, watchedBySeries } = repo.progressSnapshot(db);
  const out = new Map();
  for (const series of allSeries) {
    out.set(
      series.id,
      progressFrom(filesBySeries.get(series.id) ?? [], watchedBySeries.get(series.id) ?? new Set(), series)
    );
  }
  return out;
}
