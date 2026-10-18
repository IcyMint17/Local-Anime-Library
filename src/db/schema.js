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
  favorite      INTEGER DEFAULT 0,
  ep_offset     INTEGER DEFAULT 0,
  ep_offset_auto INTEGER DEFAULT 1,
  match_state   TEXT,
  match_score   REAL,
  manual        INTEGER DEFAULT 0,
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
  ep_key    TEXT,
  number    REAL,
  sort      REAL,
  ep        REAL,
  type      INTEGER DEFAULT 0,
  bangumi_id INTEGER,
  title     TEXT,
  title_cn  TEXT,
  air_date  TEXT,
  UNIQUE(series_id, ep_key)
);

-- A local folder can hold several Bangumi entries (无职转生 ～…～ carries both
-- 第1部分 and 第2部分). The primary one stays on series.bangumi_id; this table
-- records every part the folder actually covers.
CREATE TABLE IF NOT EXISTS series_subjects (
  series_id  INTEGER,
  bangumi_id INTEGER,
  position   INTEGER,
  title_cn   TEXT,
  title_orig TEXT,
  primary_part INTEGER DEFAULT 0,
  PRIMARY KEY (series_id, bangumi_id)
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
  ensureColumn(db, 'series', 'favorite', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'series', 'manual', 'INTEGER DEFAULT 0');
  rebuildEpisodesIfStale(db);
}

/**
 * Bangumi numbers its specials in their own space: 孤独摇滚！ has main episodes
 * 1..12 *and* SP entries also numbered 1, 2, 3 and 11.5. Storing episodes keyed
 * by (series, number) let those overwrite the real episodes, so the table is
 * keyed by a composite key instead. Episode rows are cheap to refetch, so an
 * old table is simply rebuilt.
 */
function rebuildEpisodesIfStale(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episodes'").get();
  if (!row?.sql) return;
  if (row.sql.includes('ep_key')) return;
  db.exec('DROP TABLE episodes');
  db.exec(`CREATE TABLE episodes (
    id        INTEGER PRIMARY KEY,
    series_id INTEGER,
    ep_key    TEXT,
    number    REAL,
    sort      REAL,
    ep        REAL,
    type      INTEGER DEFAULT 0,
    bangumi_id INTEGER,
    title     TEXT,
    title_cn  TEXT,
    air_date  TEXT,
    UNIQUE(series_id, ep_key)
  );`);
}

/** Adds a column when an older database predates it. */
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
