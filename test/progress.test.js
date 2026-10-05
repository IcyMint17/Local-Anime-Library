import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase, insertSeries, upsertFile, setWatchMark, listSeries } from '../src/db/repo.js';
import { computeProgress, computeProgressAll } from '../src/library/progress.js';

function buildLibrary(seriesCount = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-progress-'));
  const db = openDatabase(path.join(dir, 'library.db'));
  for (let s = 0; s < seriesCount; s += 1) {
    const seriesId = insertSeries(db, {
      local_key: `k|series-${s}|x`,
      source_folder: `series-${s}`,
      eps_total: 12,
      media_kind: 'episode',
    });
    for (let ep = 1; ep <= 12; ep += 1) {
      upsertFile(db, seriesId, {
        path: path.join(dir, `s${s}`, `[${ep}].mkv`),
        name: `[${ep}].mkv`,
        kind: 'episode',
        ep_number: ep,
      });
      if (ep <= s) setWatchMark(db, seriesId, `ep:${ep}`, true);
    }
    upsertFile(db, seriesId, {
      path: path.join(dir, `s${s}`, '[NCED].mkv'),
      name: '[NCED].mkv',
      kind: 'special',
    });
  }
  const movieId = insertSeries(db, {
    local_key: 'k|movie|x',
    source_folder: 'movie',
    eps_total: 1,
    media_kind: 'movie',
  });
  upsertFile(db, movieId, { path: path.join(dir, 'movie.mkv'), name: 'movie.mkv', kind: 'movie' });
  setWatchMark(db, movieId, 'movie', true);
  return { db, dir };
}

test('computeProgressAll agrees with per-series computeProgress', () => {
  const { db } = buildLibrary();
  const series = listSeries(db);
  const batched = computeProgressAll(db, series);
  assert.equal(batched.size, series.length);
  for (const row of series) {
    assert.deepEqual(batched.get(row.id), computeProgress(db, row), `series ${row.source_folder}`);
  }
  db.close();
});

test('computeProgressAll issues a fixed number of queries regardless of library size', () => {
  for (const count of [3, 12]) {
    const { db } = buildLibrary(count);
    const series = listSeries(db);

    let prepared = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      prepared += 1;
      return realPrepare(sql);
    };

    computeProgressAll(db, series);
    const batchedQueries = prepared;

    prepared = 0;
    for (const row of series) computeProgress(db, row);
    const perSeriesQueries = prepared;

    assert.equal(batchedQueries, 2, `batched should be 2 queries, got ${batchedQueries}`);
    assert.equal(perSeriesQueries, series.length * 2, 'the old path is two queries per series');
    db.close();
  }
});

test('progressFrom handles a series with no files at all', () => {
  const { db } = buildLibrary(1);
  const emptyId = insertSeries(db, { local_key: 'k|empty|x', source_folder: 'empty', eps_total: 0 });
  const progress = computeProgress(db, listSeries(db).find((row) => row.id === emptyId));
  assert.equal(progress.status, 'none');
  assert.equal(progress.totalFiles, 0);
  assert.equal(progress.percent, 0);
  db.close();
});

test('progressFrom does not count extras towards completion', () => {
  const { db } = buildLibrary(1);
  const series = listSeries(db).find((row) => row.source_folder === 'series-0');
  const progress = computeProgress(db, series);
  assert.equal(progress.localTotal, 12);
  assert.equal(progress.specials, 1);
  assert.equal(progress.totalFiles, 13, 'the extra file is still part of the library');
  db.close();
});

test('progressFrom treats a movie as a single watchable item', () => {
  const { db } = buildLibrary(1);
  const movie = listSeries(db).find((row) => row.media_kind === 'movie');
  const progress = computeProgress(db, movie);
  assert.equal(progress.status, 'completed');
  assert.equal(progress.total, 1);
  db.close();
});
