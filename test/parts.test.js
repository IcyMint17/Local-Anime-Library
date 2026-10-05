import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openDatabase,
  insertSeries,
  updateSeries,
  upsertFile,
  listFiles,
  replaceEpisodes,
  listEpisodes,
  listSeriesSubjects,
} from '../src/db/repo.js';
import { syncEpisodes, reclassifyFromBangumi, uncoveredNumbers, allLocalNumbers } from '../src/library/parts.js';
import { computeProgress } from '../src/library/progress.js';

function freshDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-parts-'));
  return { db: openDatabase(path.join(dir, 'library.db')), dir };
}

const episode = (number, type = 0, title = `ep ${number}`) => ({
  number,
  sort: number,
  ep: type === 0 ? number : 0,
  type,
  title,
  title_cn: title,
  air_date: null,
});

function fakeClient(catalog) {
  return {
    proxy: null,
    userAgent: 'test',
    logger: { warn() {} },
    async getEpisodes(id) {
      return catalog[id]?.episodes ?? [];
    },
    async getSubject(id) {
      return catalog[id]?.subject ?? { id, name_cn: `subject ${id}`, name: `subject ${id}` };
    },
    async searchSubjects() {
      return Object.entries(catalog)
        .filter(([, entry]) => entry.searchable)
        .map(([id, entry]) => ({ id: Number(id), ...entry.subject }));
    },
  };
}

function addEpisodes(db, seriesId, numbers, kinds = {}) {
  for (const number of numbers) {
    upsertFile(db, seriesId, {
      path: path.join('E:\\library', `[${number}].mkv`),
      name: `[${number}].mkv`,
      kind: kinds[number] ?? 'episode',
      ep_number: number,
      ep_label: String(number),
    });
  }
}

test('uncoveredNumbers finds local numbers the current episode list does not cover', () => {
  const episodes = [episode(1), episode(2), episode(3)];
  assert.deepEqual(uncoveredNumbers([1, 2, 3], episodes, 0), []);
  assert.deepEqual(uncoveredNumbers([1, 2, 3, 4, 5], episodes, 0), [4, 5]);
  assert.deepEqual(uncoveredNumbers([67, 68], [episode(1), episode(2)], -66), []);
});

test('reclassifyFromBangumi demotes a local episode that Bangumi marks as SP', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|p|x', source_folder: 'p' });
  // 无职转生 第2部分: main 12..23, plus an SP at 24.
  replaceEpisodes(db, seriesId, [
    ...Array.from({ length: 12 }, (_, index) => episode(12 + index)),
    episode(24, 1, '艾莉丝的哥布林讨伐'),
  ]);
  addEpisodes(db, seriesId, [12, 13, 14, 23, 24]);

  const changed = reclassifyFromBangumi(db, seriesId, 0);
  assert.equal(changed, 1);
  const kinds = Object.fromEntries(listFiles(db, seriesId).map((file) => [file.ep_number, file.kind]));
  assert.equal(kinds[24], 'special', 'episode 24 is an SP on Bangumi');
  assert.equal(kinds[23], 'episode');
  db.close();
});

test('reclassifyFromBangumi never promotes an extra that merely shares a number', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|q|x', source_folder: 'q' });
  replaceEpisodes(db, seriesId, [episode(1), episode(2)]);
  // 孤独摇滚！ ships 「歌曲欣赏 01」 alongside the real episode 1.
  addEpisodes(db, seriesId, [1, 2], { 1: 'special' });
  upsertFile(db, seriesId, {
    path: 'E:\\library\\songs\\[歌曲欣赏][01].mkv',
    name: '[歌曲欣赏][01].mkv',
    kind: 'special',
    ep_number: 1,
  });

  assert.equal(reclassifyFromBangumi(db, seriesId, 0), 0);
  const files = listFiles(db, seriesId);
  const songs = files.find((file) => file.name.includes('歌曲欣赏'));
  assert.equal(songs.kind, 'special', 'the extra keeps its parser classification');
  assert.equal(files.filter((file) => file.kind === 'special').length, 2, '歌曲欣赏 01 + the [1] special');
  db.close();
});

test('reclassifyFromBangumi keeps a real episode when an SP reuses its number', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|sp|x', source_folder: 'sp' });
  // 孤独摇滚！: main 1..3 plus SP entries also numbered 1..3 and an 11.5 short.
  replaceEpisodes(db, seriesId, [
    ...[1, 2, 3].map((number) => episode(number, 0, `本篇 ${number}`)),
    ...[1, 2, 3].map((number) => episode(number, 1, `特番 ${number}`)),
    { ...episode(11.5, 1, '姐姐观察日记'), sort: 11.5, ep: 0 },
  ]);
  addEpisodes(db, seriesId, [1, 2, 3, 11.5]);

  const changed = reclassifyFromBangumi(db, seriesId, 0);
  assert.equal(changed, 1, 'only the 11.5 short is an SP');
  const kinds = Object.fromEntries(listFiles(db, seriesId).map((file) => [file.ep_number, file.kind]));
  assert.equal(kinds[1], 'episode');
  assert.equal(kinds[2], 'episode');
  assert.equal(kinds[3], 'episode');
  assert.equal(kinds[11.5], 'special');
  db.close();
});

test('syncEpisodes attaches a sibling part when the folder spans two entries', async () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, {
    local_key: 'a|r|x',
    source_folder: 'r',
    title_cn: '无职转生～到了异世界就拿出真本事～',
    bangumi_id: 277554,
    match_state: 'auto',
    media_kind: 'episode',
    ep_offset_auto: 1,
  });
  // local numbering continues across both parts, exactly like the real files
  addEpisodes(db, seriesId, Array.from({ length: 13 }, (_, index) => 12 + index));

  const client = fakeClient({
    277554: { subject: { id: 277554, name_cn: '无职转生～…～', name: '無職転生' }, episodes: Array.from({ length: 11 }, (_, i) => episode(1 + i)) },
    325585: {
      searchable: true,
      subject: { id: 325585, name_cn: '无职转生～…～ 第2部分', name: '無職転生 第2クール' },
      episodes: [...Array.from({ length: 12 }, (_, i) => episode(12 + i)), episode(24, 1, '艾莉丝的哥布林讨伐')],
    },
  });

  const result = await syncEpisodes({ db, client, series: { id: seriesId, bangumi_id: 277554, ep_offset_auto: 1 }, query: '无职转生' });

  assert.equal(result.offset, 0, 'sort numbering already lines up');
  assert.equal(result.addedParts, 1, 'the second part was attached');
  const parts = listSeriesSubjects(db, seriesId);
  assert.deepEqual(parts.map((part) => part.bangumi_id), [277554, 325585]);
  assert.equal(listEpisodes(db, seriesId).length, 24, '11 + 12 main + 1 SP');

  const kinds = Object.fromEntries(listFiles(db, seriesId).map((file) => [file.ep_number, file.kind]));
  assert.equal(kinds[24], 'special', 'the SP from Bangumi is recognised locally');
  db.close();
});

test('a movie still reaches 已看完 after 全部已看', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, {
    local_key: 'a|m|x',
    source_folder: 'm',
    title_cn: '超辉夜姬！',
    media_kind: 'movie',
    eps_total: 1,
  });
  upsertFile(db, seriesId, {
    path: 'E:\\library\\movie.mkv',
    name: 'Chou Kaguya-hime! - Movie.mkv',
    kind: 'movie',
    ep_number: null,
  });
  upsertFile(db, seriesId, { path: 'E:\\library\\mv.mkv', name: 'ray MV.mkv', kind: 'special', ep_number: null });

  const before = computeProgress(db, getSeriesRow(db, seriesId));
  assert.equal(before.status, 'none');
  assert.equal(before.total, 2, 'both files are watchable items');

  db.prepare('INSERT INTO watch_marks (series_id, item_key, watched) VALUES (?,?,1)').run(seriesId, 'movie');
  db.prepare('INSERT INTO watch_marks (series_id, item_key, watched) VALUES (?,?,1)').run(
    seriesId,
    `file:${db.prepare('SELECT id FROM files WHERE series_id=? AND kind=?').get(seriesId, 'special').id}`
  );

  const after = computeProgress(db, getSeriesRow(db, seriesId));
  assert.equal(after.status, 'completed');
  assert.equal(after.percent, 1);
  db.close();
});

function getSeriesRow(db, id) {
  return db.prepare('SELECT * FROM series WHERE id = ?').get(id);
}

test('allLocalNumbers includes files already classified as extras', () => {
  const { db } = freshDatabase();
  const seriesId = insertSeries(db, { local_key: 'a|s|x', source_folder: 's' });
  addEpisodes(db, seriesId, [1, 2, 24], { 24: 'special' });
  assert.deepEqual(allLocalNumbers(db, seriesId).sort((a, b) => a - b), [1, 2, 24]);
  db.close();
});
