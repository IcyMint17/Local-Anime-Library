import test from 'node:test';
import assert from 'node:assert/strict';

import { mapEpisode, isMainEpisodeType, BangumiClient } from '../src/meta/bangumi.js';
import { openDatabase, insertSeries, replaceEpisodes, listEpisodes } from '../src/db/repo.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Copied verbatim from GET https://api.bgm.tv/v0/episodes?subject_id=328609
const REAL_EPISODE = {
  airdate: '2022-10-08',
  name: '転がるぼっち',
  name_cn: '翻转孤独',
  duration: '00:23:40',
  desc: '極度の人見知りで陰キャな少女、後藤ひとり。…',
  ep: 1,
  sort: 1,
  id: 1128641,
  subject_id: 328609,
  comment: 433,
  type: 0,
  disc: 0,
  duration_seconds: 1420,
};

test('mapEpisode translates the API field names the rest of the app expects', () => {
  const mapped = mapEpisode(REAL_EPISODE, 0);
  assert.deepEqual(mapped, {
    number: 1,
    sort: 1,
    ep: 1,
    type: 0,
    title: '転がるぼっち',
    title_cn: '翻转孤独',
    air_date: '2022-10-08',
  });
  // The keys the repository and the HTTP API read must actually exist.
  assert.ok('title' in mapped && 'title_cn' in mapped && 'air_date' in mapped);
});

test('mapEpisode uses the continuous sort number, not the per-entry ep', () => {
  // 无职转生 第2部分 is numbered 1..12 on its own page but 12..23 across the series.
  const secondCour = mapEpisode({ sort: 12, ep: 1, type: 0, name: '持有魔眼的女人', name_cn: '持有魔眼的女人' });
  assert.equal(secondCour.number, 12, 'sort wins so local files numbered 12..24 line up');
  assert.equal(secondCour.ep, 1, 'the printed episode number is still kept');

  // Re:Zero 第四季 喪失編 runs 67..77.
  assert.equal(mapEpisode({ sort: 67, ep: 1, type: 0 }).number, 67);
});

test('mapEpisode keeps specials and their fractional sort numbers', () => {
  const sp = mapEpisode({ sort: 24, ep: 0, type: 1, name: '艾莉丝的哥布林讨伐', name_cn: '艾莉丝的哥布林讨伐' });
  assert.equal(sp.number, 24);
  assert.equal(sp.type, 1);
  assert.equal(isMainEpisodeType(sp.type), false);

  const midSeasonSp = mapEpisode({ sort: 18.5, ep: 0, type: 1 });
  assert.equal(midSeasonSp.number, 18.5);
  assert.equal(isMainEpisodeType(midSeasonSp.type), false);

  assert.ok(isMainEpisodeType(0));
  assert.ok(isMainEpisodeType(undefined), 'missing type means 本篇');
  assert.ok(!isMainEpisodeType(4), 'PV entries are extras');
});

test('mapEpisode falls back to sort then to the list index', () => {
  assert.equal(mapEpisode({ sort: 7 }, 0).number, 7);
  assert.equal(mapEpisode({}, 4).number, 5);
  assert.equal(mapEpisode({ name: 'x' }, 2).title, 'x');
  assert.equal(mapEpisode({ name_cn: '中文' }, 0).title_cn, '中文');
});

test('episode titles survive the trip into the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-episode-test-'));
  const db = openDatabase(path.join(dir, 'library.db'));
  const seriesId = insertSeries(db, { local_key: 'a|b|x', source_folder: 'b' });

  replaceEpisodes(db, seriesId, [REAL_EPISODE, { ...REAL_EPISODE, ep: 2, sort: 2, name: 'ひとりぼっち', name_cn: '孤独一人' }].map(mapEpisode));

  const stored = listEpisodes(db, seriesId);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].title, '転がるぼっち');
  assert.equal(stored[0].title_cn, '翻转孤独');
  assert.equal(stored[0].air_date, '2022-10-08');
  assert.equal(stored[1].title_cn, '孤独一人');
  db.close();
});

test('extractAliases only picks alternate-title rows out of the infobox', () => {
  const subject = {
    infobox: [
      { key: '中文名', value: '少女乐队的呐喊' },
      { key: '别名', value: [{ v: 'GIRLS BAND CRY' }, { v: 'GBC' }] },
      { key: '导演', value: [{ v: '酒井和男' }] },
      { key: '官方网站', value: 'https://girls-band-cry.com/tv/' },
    ],
  };
  assert.deepEqual(BangumiClient.extractAliases(subject), ['少女乐队的呐喊', 'GIRLS BAND CRY', 'GBC']);
  assert.deepEqual(BangumiClient.extractAliases({}), []);
});

test('normaliseSubject prefers the Chinese title and keeps the original', () => {
  const normalised = BangumiClient.normaliseSubject({
    id: 328609,
    name: 'ぼっち・ざ・ろっく！',
    name_cn: '孤独摇滚！',
    date: '2022-10-08',
    eps: 12,
    summary: '简介',
    images: { large: 'https://lain.bgm.tv/pic/cover/l/x.jpg' },
    rating: { score: 8.4, total: 41185 },
  });
  assert.equal(normalised.title_cn, '孤独摇滚！');
  assert.equal(normalised.title_orig, 'ぼっち・ざ・ろっく！');
  assert.equal(normalised.eps_total, 12);
  assert.equal(normalised.cover_url, 'https://lain.bgm.tv/pic/cover/l/x.jpg');
  assert.equal(normalised.rating_count, 41185);
});
