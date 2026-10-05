import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openDatabase,
  insertSeries,
  updateSeries,
  getSeries,
  listSeries,
  upsertFile,
  listFiles,
  markMissingFiles,
  setWatchMark,
  listWatchMarks,
  replaceEpisodes,
  listEpisodes,
  replaceCandidates,
  listCandidates,
  startScanRun,
  finishScanRun,
  lastScanRun,
  getCache,
  setCache,
} from '../src/db/repo.js';
import { computeProgress } from '../src/library/progress.js';

function freshDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-library-test-'));
  return { db: openDatabase(path.join(dir, 'library.db')), dir };
}

const makeFile = (overrides = {}) => ({
  path: 'E:\\Videos\\Anime\\孤独摇滚！\\[DBD-Raws]\\[01].mkv',
  name: '[01].mkv',
  ext: '.mkv',
  size: 1024,
  mtime: new Date().toISOString(),
  kind: 'episode',
  season: null,
  ep_number: 1,
  ep_label: '01',
  confidence: 0.9,
  ...overrides,
});

test('series: insert, update and lookup by local key', () => {
  const { db } = freshDatabase();
  const id = insertSeries(db, {
    local_key: 'E:\\Videos\\Anime|孤独摇滚！|x',
    source_folder: '孤独摇滚！',
    title_cn: '孤独摇滚！',
    media_kind: 'episode',
    match_state: 'unmatched',
  });
  assert.ok(id > 0);
  assert.equal(getSeries(db, id).source_folder, '孤独摇滚！');

  updateSeries(db, id, { bangumi_id: 328609, match_state: 'auto', eps_total: 12 });
  const updated = getSeries(db, id);
  assert.equal(updated.bangumi_id, 328609);
  assert.equal(updated.match_state, 'auto');

  assert.equal(
    getSeries(db, insertSeries(db, { local_key: 'other|紫罗兰永恒花园|x', source_folder: '紫罗兰永恒花园' })).source_folder,
    '紫罗兰永恒花园'
  );
  assert.equal(listSeries(db).length, 2);
  db.close();
});

test('files: upsert is idempotent and missing files are flagged, not deleted', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|b|x', source_folder: 'b' });
  const first = upsertFile(db, seriesId, makeFile());
  const second = upsertFile(db, seriesId, makeFile({ size: 2048 }));
  assert.equal(first, second, 'same path must reuse the row');

  upsertFile(db, seriesId, makeFile({ path: 'E:\\Videos\\Anime\\b\\[02].mkv', ep_number: 2, ep_label: '02' }));
  assert.equal(listFiles(db, seriesId).length, 2);

  const marked = markMissingFiles(db, seriesId, ['E:\\Videos\\Anime\\孤独摇滚！\\[DBD-Raws]\\[01].mkv']);
  assert.equal(marked, 1);
  assert.equal(listFiles(db, seriesId).length, 1);
  assert.equal(listFiles(db, seriesId)[0].size, 2048, 'surviving file keeps its updated size');
  db.close();
});

test('progress: none -> watching -> completed, and specials never count', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, {
    local_key: 'a|b|x',
    source_folder: 'b',
    title_cn: 'b',
    eps_total: 3,
    media_kind: 'episode',
  });
  for (const number of [1, 2, 3]) {
    upsertFile(db, seriesId, makeFile({ path: `E:\\b\\[0${number}].mkv`, ep_number: number, ep_label: `0${number}` }));
  }
  upsertFile(
    db,
    seriesId,
    makeFile({ path: 'E:\\b\\[NCED].mkv', kind: 'special', ep_number: null, ep_label: null })
  );

  let series = getSeries(db, seriesId);
  assert.equal(computeProgress(db, series).status, 'none');
  assert.equal(computeProgress(db, series).localTotal, 3);
  assert.equal(computeProgress(db, series).specials, 1);

  setWatchMark(db, seriesId, 'ep:1', true);
  series = getSeries(db, seriesId);
  let progress = computeProgress(db, series);
  assert.equal(progress.status, 'watching');
  assert.equal(progress.watched, 1);

  setWatchMark(db, seriesId, 'ep:2', true);
  setWatchMark(db, seriesId, 'ep:3', true);
  progress = computeProgress(db, getSeries(db, seriesId));
  assert.equal(progress.status, 'completed');
  assert.equal(progress.percent, 1);

  setWatchMark(db, seriesId, 'ep:2', false);
  progress = computeProgress(db, getSeries(db, seriesId));
  assert.equal(progress.status, 'watching');
  assert.equal(progress.watched, 2);
  db.close();
});

test('progress: having fewer episodes than Bangumi keeps the series watching', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|c|x', source_folder: 'c', eps_total: 12 });
  for (const number of [1, 2, 3, 4, 5]) {
    upsertFile(db, seriesId, makeFile({ path: `E:\\c\\[0${number}].mkv`, ep_number: number }));
    setWatchMark(db, seriesId, `ep:${number}`, true);
  }
  const progress = computeProgress(db, getSeries(db, seriesId));
  assert.equal(progress.localTotal, 5);
  assert.equal(progress.total, 12);
  assert.equal(progress.status, 'watching', 'watched everything we own, but the season is incomplete');
  db.close();
});

test('progress: half episodes are distinct watchable items', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|d|x', source_folder: 'd', eps_total: 12 });
  upsertFile(db, seriesId, makeFile({ path: 'E:\\d\\[11].mkv', ep_number: 11, ep_label: '11' }));
  upsertFile(db, seriesId, makeFile({ path: 'E:\\d\\[11.5].mkv', ep_number: 11.5, ep_label: '11.5' }));
  setWatchMark(db, seriesId, 'ep:11', true);
  setWatchMark(db, seriesId, 'ep:11.5', true);
  const progress = computeProgress(db, getSeries(db, seriesId));
  assert.equal(progress.localTotal, 2);
  assert.equal(progress.watched, 2);
  assert.equal(progress.status, 'watching');
  db.close();
});

test('episodes, candidates, scan runs and metadata cache round trip', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|e|x', source_folder: 'e' });

  replaceEpisodes(db, seriesId, [
    { number: 1, sort: 1, title: '第一话', title_cn: '第一集', air_date: '2022-10-09' },
    { number: 2, sort: 2, title: '第二话', title_cn: '第二集', air_date: '2022-10-16' },
  ]);
  assert.equal(listEpisodes(db, seriesId).length, 2);
  replaceEpisodes(db, seriesId, [{ number: 1, sort: 1, title: 'x' }]);
  assert.equal(listEpisodes(db, seriesId).length, 1, 'replace must not accumulate duplicates');

  replaceCandidates(db, seriesId, [
    { id: 1, name_cn: '低分', score: 0.4 },
    { id: 2, name_cn: '高分', score: 0.9 },
  ]);
  const candidates = listCandidates(db, seriesId);
  assert.equal(candidates[0].id, 2, 'candidates come back sorted by score');

  const runId = startScanRun(db);
  finishScanRun(db, runId, { filesSeen: 340, groups: 23, matched: 22, unmatched: 1 });
  assert.equal(lastScanRun(db).matched, 22);

  setCache(db, 'subject:1', { id: 1, name_cn: '缓存' });
  assert.equal(getCache(db, 'subject:1').value.name_cn, '缓存');
  assert.equal(getCache(db, 'missing'), null);
  db.close();
});

test('watch marks are unique per series and item', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|f|x', source_folder: 'f' });
  setWatchMark(db, seriesId, 'ep:1', true);
  setWatchMark(db, seriesId, 'ep:1', false);
  setWatchMark(db, seriesId, 'ep:1', true);
  const marks = listWatchMarks(db, seriesId);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].watched, 1);
  assert.ok(marks[0].watched_at);
  db.close();
});
