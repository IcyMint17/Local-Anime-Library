/**
 * The only module that writes to SQLite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './schema.js';

const now = () => new Date().toISOString();
const bool = (value) => (value ? 1 : 0);

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/* ------------------------------------------------------------------ series */

export function findSeriesByLocalKey(db, localKey) {
  return db.prepare('SELECT * FROM series WHERE local_key = ?').get(localKey) ?? null;
}

export function getSeries(db, id) {
  return db.prepare('SELECT * FROM series WHERE id = ?').get(id) ?? null;
}

export function listSeries(db) {
  return db.prepare('SELECT * FROM series ORDER BY title_cn COLLATE NOCASE, source_folder COLLATE NOCASE').all();
}

export function insertSeries(db, row) {
  const timestamp = now();
  const info = db
    .prepare(
      `INSERT INTO series (local_key, source_folder, bangumi_id, title_cn, title_orig, title_jp,
         summary, air_date, eps_total, cover_url, cover_path, rating, rating_count,
         media_kind, season, match_state, match_score, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      row.local_key ?? null,
      row.source_folder ?? null,
      row.bangumi_id ?? null,
      row.title_cn ?? null,
      row.title_orig ?? null,
      row.title_jp ?? null,
      row.summary ?? null,
      row.air_date ?? null,
      row.eps_total ?? null,
      row.cover_url ?? null,
      row.cover_path ?? null,
      row.rating ?? null,
      row.rating_count ?? null,
      row.media_kind ?? null,
      row.season ?? null,
      row.match_state ?? 'unmatched',
      row.match_score ?? null,
      timestamp,
      timestamp
    );
  return Number(info.lastInsertRowid);
}

export function updateSeries(db, id, patch) {
  const columns = Object.keys(patch);
  if (columns.length === 0) return;
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  const values = columns.map((column) => patch[column] ?? null);
  db.prepare(`UPDATE series SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
}

export function deleteSeries(db, id) {
  db.prepare('DELETE FROM watch_marks WHERE series_id = ?').run(id);
  db.prepare('DELETE FROM match_candidates WHERE series_id = ?').run(id);
  db.prepare('DELETE FROM episodes WHERE series_id = ?').run(id);
  db.prepare('DELETE FROM files WHERE series_id = ?').run(id);
  db.prepare('DELETE FROM series WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------- files */

export function upsertFile(db, seriesId, file) {
  const existing = db.prepare('SELECT id FROM files WHERE path = ?').get(file.path);
  const params = [
    seriesId,
    file.name ?? null,
    file.ext ?? null,
    file.size ?? null,
    file.mtime ?? null,
    file.kind ?? 'episode',
    file.season ?? null,
    file.ep_number ?? null,
    file.ep_label ?? null,
    file.confidence ?? null,
  ];
  if (existing) {
    db.prepare(
      `UPDATE files SET series_id=?, name=?, ext=?, size=?, mtime=?, kind=?, season=?, ep_number=?,
         ep_label=?, confidence=?, missing=0 WHERE id=?`
    ).run(...params, existing.id);
    return Number(existing.id);
  }
  const info = db
    .prepare(
      `INSERT INTO files (path, series_id, name, ext, size, mtime, kind, season, ep_number, ep_label, confidence, missing)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`
    )
    .run(file.path, ...params);
  return Number(info.lastInsertRowid);
}

export function listFiles(db, seriesId) {
  return db.prepare('SELECT * FROM files WHERE series_id = ? AND missing = 0 ORDER BY ep_number IS NULL, ep_number, name COLLATE NOCASE').all(seriesId);
}

export function getFile(db, id) {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) ?? null;
}

export function updateFileKind(db, id, kind) {
  db.prepare('UPDATE files SET kind = ? WHERE id = ?').run(kind, id);
}

/** Marks files that no longer exist on disk. Returns how many were marked. */
export function markMissingFiles(db, seriesId, keepPaths) {
  const rows = db.prepare('SELECT id, path FROM files WHERE series_id = ?').all(seriesId);
  const keep = new Set(keepPaths);
  let marked = 0;
  for (const row of rows) {
    const shouldBeMissing = !keep.has(row.path);
    db.prepare('UPDATE files SET missing = ? WHERE id = ?').run(bool(shouldBeMissing), row.id);
    if (shouldBeMissing) marked += 1;
  }
  return marked;
}

/* ---------------------------------------------------------------- episodes */

export function replaceEpisodes(db, seriesId, episodes) {
  db.prepare('DELETE FROM episodes WHERE series_id = ?').run(seriesId);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO episodes (series_id, ep_key, number, sort, ep, type, bangumi_id, title, title_cn, air_date)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  for (const episode of episodes) {
    insert.run(
      seriesId,
      `${episode.bangumi_id ?? 0}:${episode.type ?? 0}:${episode.number}`,
      episode.number ?? null,
      episode.sort ?? null,
      episode.ep ?? null,
      episode.type ?? 0,
      episode.bangumi_id ?? null,
      episode.title ?? null,
      episode.title_cn ?? null,
      episode.air_date ?? null
    );
  }
}

export function listEpisodes(db, seriesId) {
  return db.prepare('SELECT * FROM episodes WHERE series_id = ? ORDER BY sort').all(seriesId);
}

/** Replaces the recorded list of Bangumi parts a folder covers. */
export function replaceSeriesSubjects(db, seriesId, subjects) {
  db.prepare('DELETE FROM series_subjects WHERE series_id = ?').run(seriesId);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO series_subjects (series_id, bangumi_id, position, title_cn, title_orig, primary_part)
     VALUES (?,?,?,?,?,?)`
  );
  subjects.forEach((subject, index) => {
    insert.run(
      seriesId,
      subject.id,
      index,
      subject.name_cn ?? null,
      subject.name ?? null,
      subject.primary ? 1 : 0
    );
  });
}

export function listSeriesSubjects(db, seriesId) {
  return db.prepare('SELECT * FROM series_subjects WHERE series_id = ? ORDER BY position').all(seriesId);
}

/* ------------------------------------------------------------ watch marks */

export function listWatchMarks(db, seriesId) {
  return db.prepare('SELECT * FROM watch_marks WHERE series_id = ?').all(seriesId);
}

/** Most recently watched series first — powers the 继续观看 strip. */
export function recentWatchMarks(db, limit = 8) {
  return db
    .prepare(
      `SELECT series_id, MAX(watched_at) AS watched_at
         FROM watch_marks
        WHERE watched = 1 AND watched_at IS NOT NULL
        GROUP BY series_id
        ORDER BY watched_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/** The item keys the user has already ticked off for one series. */
export function watchedItemKeys(db, seriesId) {
  return new Set(
    db
      .prepare('SELECT item_key FROM watch_marks WHERE series_id = ? AND watched = 1')
      .all(seriesId)
      .map((row) => row.item_key)
  );
}

/**
 * Everything the progress calculation needs, for every series at once.
 *
 * Reading progress one series at a time meant two queries per series on every
 * library call (25 series → 50 queries, and the UI calls this after each
 * checkbox click). Both chunks come back in a single query instead.
 */
export function progressSnapshot(db) {
  const filesBySeries = new Map();
  for (const row of db
    .prepare('SELECT series_id, id, kind, ep_number FROM files WHERE missing = 0')
    .all()) {
    if (!filesBySeries.has(row.series_id)) filesBySeries.set(row.series_id, []);
    filesBySeries.get(row.series_id).push(row);
  }

  const watchedBySeries = new Map();
  for (const row of db
    .prepare('SELECT series_id, item_key FROM watch_marks WHERE watched = 1')
    .all()) {
    if (!watchedBySeries.has(row.series_id)) watchedBySeries.set(row.series_id, new Set());
    watchedBySeries.get(row.series_id).add(row.item_key);
  }

  return { filesBySeries, watchedBySeries };
}

export function setWatchMark(db, seriesId, itemKey, watched) {
  db.prepare(
    `INSERT INTO watch_marks (series_id, item_key, watched, watched_at) VALUES (?,?,?,?)
     ON CONFLICT(series_id, item_key) DO UPDATE SET watched = excluded.watched, watched_at = excluded.watched_at`
  ).run(seriesId, itemKey, bool(watched), watched ? now() : null);
}

/**
 * Flag a series as a favourite. Deliberately bypasses `updateSeries` so that
 * starring something does not bump `updated_at` and reshuffle "最近扫描" —
 * a favourite is a bookmark, not a library change.
 */
export function setFavorite(db, seriesId, favorite) {
  db.prepare('UPDATE series SET favorite = ? WHERE id = ?').run(bool(favorite), seriesId);
}

/**
 * Every watch tick with a timestamp, newest first, joined with the series it
 * belongs to. The timeline aggregates these per day in the UI.
 */
export function recentWatchEvents(db, limit = 80) {
  return db
    .prepare(
      `SELECT w.series_id, w.item_key, w.watched_at,
              s.title_cn, s.title_orig, s.cover_path, s.cover_url,
              s.media_kind, s.ep_offset
         FROM watch_marks w
         JOIN series s ON s.id = w.series_id
        WHERE w.watched = 1 AND w.watched_at IS NOT NULL
        ORDER BY w.watched_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/** All episodes in one query, so the timeline does not fetch per series. */
export function allEpisodes(db) {
  return db.prepare('SELECT * FROM episodes ORDER BY series_id, sort').all();
}

/** All files in one query, for "is this episode actually on disk" checks. */
export function allFiles(db) {
  return db.prepare('SELECT * FROM files WHERE missing = 0').all();
}

/** Main episodes whose air date falls in [from, to] (YYYY-MM-DD). */
export function upcomingEpisodes(db, from, to) {
  return db
    .prepare(
      `SELECT e.series_id, e.number, e.title_cn, e.title, e.air_date,
              s.title_cn AS series_title, s.cover_path, s.cover_url, s.media_kind
         FROM episodes e
         JOIN series s ON s.id = e.series_id
        WHERE e.type = 0 AND e.air_date IS NOT NULL AND e.air_date >= ? AND e.air_date <= ?
        ORDER BY e.air_date, s.title_cn`
    )
    .all(from, to);
}


/* ------------------------------------------------------------- candidates */

export function replaceCandidates(db, seriesId, candidates) {
  db.prepare('DELETE FROM match_candidates WHERE series_id = ?').run(seriesId);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO match_candidates (series_id, bangumi_id, score, payload) VALUES (?,?,?,?)'
  );
  for (const candidate of candidates) {
    insert.run(seriesId, candidate.id, candidate.score ?? null, JSON.stringify(candidate));
  }
}

export function listCandidates(db, seriesId) {
  return db
    .prepare('SELECT * FROM match_candidates WHERE series_id = ? ORDER BY score DESC')
    .all(seriesId)
    .map((row) => ({ ...JSON.parse(row.payload), score: row.score }));
}

/* --------------------------------------------------------------- scan runs */

export function startScanRun(db) {
  const info = db.prepare('INSERT INTO scan_runs (started_at) VALUES (?)').run(now());
  return Number(info.lastInsertRowid);
}

export function finishScanRun(db, id, summary) {
  db.prepare(
    'UPDATE scan_runs SET finished_at=?, files_seen=?, groups=?, matched=?, unmatched=?, note=? WHERE id=?'
  ).run(
    now(),
    summary.filesSeen ?? null,
    summary.groups ?? null,
    summary.matched ?? null,
    summary.unmatched ?? null,
    summary.note ?? null,
    id
  );
}

export function lastScanRun(db) {
  return db.prepare('SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1').get() ?? null;
}

/* ------------------------------------------------------------- meta cache */

export function getCache(db, key) {
  const row = db.prepare('SELECT payload, fetched_at FROM meta_cache WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.payload), fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

export function setCache(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta_cache (key, payload, fetched_at) VALUES (?,?,?)').run(
    key,
    JSON.stringify(value),
    now()
  );
}
