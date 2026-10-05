/**
 * SQLite schema. Creating everything with IF NOT EXISTS keeps startup
 * idempotent and makes the database safe to delete and rebuild from scratch.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS series (
  id            INTEGER PRIMARY KEY,
  local_key     TEXT UNIQUE,
  source_folder TEXT,
  bangumi_id    INTEGER,
  title_cn      TEXT,
  title_orig    TEXT,
  title_jp      TEXT,
  summary       TEXT,
  air_date      TEXT,
  eps_total     INTEGER,
  cover_url     TEXT,
  cover_path    TEXT,
  rating        REAL,
  rating_count  INTEGER,
  media_kind    TEXT,
  season        INTEGER,
  ep_offset     INTEGER DEFAULT 0,
  ep_offset_auto INTEGER DEFAULT 1,
  match_state   TEXT,
  match_score   REAL,
  created_at    TEXT,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_series_bangumi ON series(bangumi_id);
CREATE INDEX IF NOT EXISTS idx_series_folder ON series(source_folder);

CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY,
  path       TEXT UNIQUE,
  series_id  INTEGER,
  name       TEXT,
  ext        TEXT,
  size       INTEGER,
  mtime      TEXT,
  kind       TEXT,
  season     INTEGER,
  ep_number  REAL,
  ep_label   TEXT,
  confidence REAL,
  missing    INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_series ON files(series_id);

CREATE TABLE IF NOT EXISTS episodes (
  id        INTEGER PRIMARY KEY,
  series_id INTEGER,
  number    REAL,
  sort      INTEGER,
  title     TEXT,
  title_cn  TEXT,
  air_date  TEXT,
  UNIQUE(series_id, number)
);

CREATE TABLE IF NOT EXISTS watch_marks (
  series_id  INTEGER,
  item_key   TEXT,
  watched    INTEGER DEFAULT 0,
  watched_at TEXT,
  PRIMARY KEY (series_id, item_key)
);

CREATE TABLE IF NOT EXISTS match_candidates (
  series_id  INTEGER,
  bangumi_id INTEGER,
  score      REAL,
  payload    TEXT,
  PRIMARY KEY (series_id, bangumi_id)
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT,
  finished_at TEXT,
  files_seen  INTEGER,
  groups      INTEGER,
  matched     INTEGER,
  unmatched   INTEGER,
  note        TEXT
);

-- Raw API responses, so a rescan never re-downloads what we already have.
CREATE TABLE IF NOT EXISTS meta_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT,
  fetched_at TEXT
);
`;

export function migrate(db) {
  db.exec(SCHEMA);
  ensureColumn(db, 'series', 'ep_offset', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'series', 'ep_offset_auto', 'INTEGER DEFAULT 1');
}

/** Adds a column when an older database predates it. */
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
