import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { walkVideos } from '../src/scan/walk.js';
import { groupFiles } from '../src/scan/group.js';

const LIBRARY = 'E:\\Videos\\Anime';
const hasLibrary = fs.existsSync(LIBRARY);

function synthetic(paths) {
  return paths.map((rel) => {
    const segments = rel.split('/');
    return {
      path: `${LIBRARY}\\${segments.join('\\')}`,
      name: segments[segments.length - 1],
      ext: '.mkv',
      relSegments: segments,
      relDirSegments: segments.slice(0, -1),
    };
  });
}

test('group: one folder holding two seasons splits into two groups', () => {
  const files = synthetic([
    '为美好的世界献上祝福/[DHR&MakariHoshiyume][Konosuba S2][01-10][BIG5][720P][AVC_AAC][MP4]/[DHR&MakariHoshiyume][Konosuba S2][01][BIG5][720P][AVC_AAC].mp4',
    '为美好的世界献上祝福/[DHR&MakariHoshiyume][Konosuba S2][01-10][BIG5][720P][AVC_AAC][MP4]/[DHR&MakariHoshiyume][Konosuba S2][02][BIG5][720P][AVC_AAC].mp4',
    '为美好的世界献上祝福/[LoliHouse] Kono Subarashii Sekai ni Shukufuku wo! S3 [01-11][WebRip 1080p HEVC-10bit AAC]/[LoliHouse] Kono Subarashii Sekai ni Shukufuku wo! S3 - 01 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv',
    '为美好的世界献上祝福/[LoliHouse] Kono Subarashii Sekai ni Shukufuku wo! S3 [01-11][WebRip 1080p HEVC-10bit AAC]/[LoliHouse] Kono Subarashii Sekai ni Shukufuku wo! S3 - 02 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv',
    '为美好的世界献上祝福/[LoliHouse] Kono Subarashii Sekai ni Shukufuku wo! S3 [01-11][WebRip 1080p HEVC-10bit AAC]/[LoliHouse] Kono Subarashii Sekai ni Shukufuku wo! S3 - 03 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv',
  ]);
  const groups = groupFiles(files, { rootName: 'Anime' });
  assert.equal(groups.length, 2);
  const seasons = groups.map((group) => group.season).sort();
  assert.deepEqual(seasons, [2, 3]);
  assert.deepEqual(
    groups.map((group) => group.files.length).sort(),
    [2, 3]
  );
  // Both groups should carry the Chinese folder name as their first query hint.
  for (const group of groups) {
    assert.equal(group.titleCandidates[0], '为美好的世界献上祝福');
  }
});

test('group: two cours of the same season stay one group', () => {
  const files = synthetic([
    '无职转生 第二季 ～到了异世界就拿出真本事～/[Comicat&KissSub] Mushoku Tensei II (00-12Fin WEBRip 1080p AVC AAC SC)/[Comicat&KissSub][Mushoku Tensei II - Isekai Ittara Honki Dasu][00v2][1080P][GB][MP4].mp4',
    '无职转生 第二季 ～到了异世界就拿出真本事～/[Comicat&KissSub] Mushoku Tensei II (13-24Fin WEBRip 1080p AVC AAC SC)/[Comicat&KissSub][Mushoku Tensei II - Isekai Ittara Honki Dasu][13][1080P][GB][MP4].mp4',
  ]);
  const groups = groupFiles(files, { rootName: 'Anime' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].season, 2);
});

test('group: series folder season is used when the file name has none', () => {
  const files = synthetic([
    'Spy x Family 间谍过家家第三季/[Sakurato] Spy x Family (2025) [01][HEVC-10bit 1080p AAC][CHS&CHT].mkv',
    'Spy x Family 间谍过家家第三季/[Sakurato] Spy x Family (2025) [02][HEVC-10bit 1080p AAC][CHS&CHT].mkv',
  ]);
  const groups = groupFiles(files, { rootName: 'Anime' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].season, 3);
});

test('group: a folder of only non-episode files becomes a movie', () => {
  const files = synthetic([
    '摇曳露营/[Airota&Nekomoe kissaten][Yuru Camp Movie][UHDRip 2160p HEVC-10bit AAC][CHS].mp4',
  ]);
  const groups = groupFiles(files, { rootName: 'Anime' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'movie');
});

test('group: explicitly named 剧场版 folder becomes a movie', () => {
  const files = synthetic([
    '中二病也要谈恋爱剧场版/[Airota][Chuunibyou_demo_Koi_ga_Shitai! -Take On Me-][Movie][BDrip_1080P][x264_AAC][CHT].mp4',
  ]);
  const groups = groupFiles(files, { rootName: 'Anime' });
  assert.equal(groups[0].kind, 'movie');
});

test('group: files in an extra sub-folder become specials, not episodes', () => {
  const release = '[DBD-Raws][孤独摇滚！][01-12TV全集+特典映像][1080P][BDRip][HEVC-10bit][FLAC][MKV]';
  const files = synthetic([
    `孤独摇滚！/${release}/[DBD-Raws][孤独摇滚！][01][1080P][BDRip][HEVC-10bit][FLAC].mkv`,
    `孤独摇滚！/${release}/[DBD-Raws][孤独摇滚！][02][1080P][BDRip][HEVC-10bit][FLAC].mkv`,
    `孤独摇滚！/${release}/歌曲欣赏/[DBD-Raws][孤独摇滚！][歌曲欣赏][01][1080P][BDRip][HEVC-10bit][FLAC].mkv`,
    `孤独摇滚！/${release}/歌曲欣赏/[DBD-Raws][孤独摇滚！][歌曲欣赏][02][1080P][BDRip][HEVC-10bit][FLAC].mkv`,
    `孤独摇滚！/${release}/谈话/[DBD-Raws][孤独摇滚！][谈话][01][1080P][BDRip][HEVC-10bit][FLAC].mkv`,
  ]);
  const groups = groupFiles(files, { rootName: 'Anime' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'episode');
  assert.equal(groups[0].files.filter((item) => item.parsed.kind === 'episode').length, 2);
  assert.equal(groups[0].files.filter((item) => item.parsed.kind === 'special').length, 3);
  // Extra sub-folder names must not leak into the search hints.
  assert.deepEqual(groups[0].titleCandidates, ['孤独摇滚！']);
});

test(
  'integration: grouping the real E:\\Videos\\Anime library',
  { skip: hasLibrary ? false : 'E:\\Videos\\Anime not present' },
  () => {
    const { files, errors } = walkVideos(LIBRARY);
    assert.equal(errors.length, 0, `walk errors: ${JSON.stringify(errors)}`);
    assert.ok(files.length > 300, `expected 300+ videos, got ${files.length}`);

    const groups = groupFiles(files, { rootName: 'Anime' });
    const byFolder = new Map(groups.map((group) => [group.sourceFolder, group]));

    // Konosuba lives in one folder but must become two entries.
    const konosuba = groups.filter((group) => group.sourceFolder === '为美好的世界献上祝福');
    assert.equal(konosuba.length, 2, 'Konosuba folder should split into two seasons');
    assert.deepEqual(konosuba.map((group) => group.season).sort(), [2, 3]);

    // The author split the two cours into separate folders, so each is its own
    // entry now. (The synthetic test above still covers the merged-folder case.)
    const mushoku2 = byFolder.get('无职转生 第二季 ～到了异世界就拿出真本事～');
    assert.equal(mushoku2.files.length, 13);
    assert.equal(mushoku2.season, 2);
    const mushoku2b = byFolder.get('无职转生 第二季 ～到了异世界就拿出真本事～ 第2部分');
    assert.equal(mushoku2b.files.length, 12);
    const mushoku1b = byFolder.get('无职转生～到了异世界就拿出真本事～ 第2部分');
    assert.equal(mushoku1b.files.length, 13);

    // 60 videos, but only 13 are real episodes (01-12 plus the 11.5 half episode).
    const bocchi = byFolder.get('孤独摇滚！');
    assert.equal(bocchi.files.length, 60);
    assert.equal(bocchi.episodeCount, 13);
    assert.equal(bocchi.files.filter((item) => item.parsed.kind === 'episode').length, 13);
    assert.equal(bocchi.kind, 'episode');

    // 12 episodes + NCED/NCOP + 12 小剧场 shorts.
    const girls = byFolder.get('少女终末旅行');
    assert.equal(girls.files.length, 26);
    assert.equal(girls.files.filter((item) => item.parsed.kind === 'special').length, 14);

    assert.equal(byFolder.get('摇曳露营').kind, 'movie');
    assert.equal(byFolder.get('中二病也要谈恋爱剧场版').kind, 'movie');
    assert.equal(byFolder.get('超时空辉夜姬！').kind, 'movie');

    // The empty folder must not appear as an entry.
    assert.equal(byFolder.has('Re：从零开始的异世界生活 第四季 夺还篇'), false);

    assert.equal(groups.length, 25, `expected 25 groups, got ${groups.length}`);
  }
);
