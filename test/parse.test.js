import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFileName,
  parseFolderName,
  parseReleaseFolderName,
  findEpisode,
  findSeason,
  similarity,
  normaliseName,
  isVideoFile,
} from '../src/scan/parse.js';

// Every file name below is copied verbatim from E:\Videos\Anime.
const FILES = [
  {
    label: 'Nekomoe dash-numbered + release group before title',
    name: '[Nekomoe kissaten&LoliHouse] ATRI -My Dear Moments- - 01 [WebRip 1080p HEVC-10bit AAC ASSx2].mkv',
    episode: 1,
    season: null,
    kind: 'episode',
    titleIncludes: 'ATRI',
  },
  {
    label: 'LPSub fully bracketed, episode in its own bracket',
    name: "[LPSub] BanG Dream! It's MyGO!!!!! [BDRip][01][1080p][AVC AAC][JPSC].mp4",
    episode: 1,
    season: null,
    kind: 'episode',
    titleIncludes: "BanG Dream! It's MyGO",
  },
  {
    label: 'Chinese-only title with a 歌曲欣赏 special marker',
    name: '[DBD-Raws][孤独摇滚！][歌曲欣赏][01][1080P][BDRip][HEVC-10bit][FLAC].mkv',
    episode: 1,
    season: null,
    kind: 'special',
    titleIncludes: '孤独摇滚',
  },
  {
    label: 'year in parentheses must not become an episode number',
    name: '[Sakurato] Spy x Family (2025) [01][HEVC-10bit 1080p AAC][CHS&CHT].mkv',
    episode: 1,
    season: null,
    kind: 'episode',
    titleIncludes: 'Spy x Family',
  },
  {
    label: 'absolute episode numbering (67)',
    name: '[hyakuhuyu&LoliHouse] Re Zero kara Hajimeru Isekai Seikatsu - 67 [WebRip 1080p HEVC-10bit AAC ASSx2].mkv',
    episode: 67,
    season: null,
    kind: 'episode',
    titleIncludes: 'Re Zero',
  },
  {
    label: 'movie tagged in brackets, no episode number',
    name: '[Airota][Chuunibyou_demo_Koi_ga_Shitai! -Take On Me-][Movie][BDrip_1080P][x264_AAC][CHT].mp4',
    episode: null,
    season: null,
    kind: 'movie',
    titleIncludes: 'Chuunibyou',
  },
  {
    label: 'BLOOM season alias + v2 revision',
    name: '[Sakurato] Gochuumon wa Usagi Desu ka BLOOM [01v2][HEVC-10bit 1080p AAC][CHS&CHT&JPN].mkv',
    episode: 1,
    season: 3,
    kind: 'episode',
    titleIncludes: 'Gochuumon',
  },
  {
    label: '3rd Season ordinal',
    name: '[Fyy Raws] Re-Zero kara Hajimeru Isekai Seikatsu 3rd Season - 01 [2160p AAC Multi-Subs].mkv',
    episode: 1,
    season: 3,
    kind: 'episode',
    titleIncludes: 'Re Zero kara Hajimeru',
  },
  {
    label: 'S3 marker in an unbracketed title',
    name: '[LoliHouse] Kono Subarashii Sekai ni Shukufuku wo! S3 - 01 [WebRip 1080p HEVC-10bit AAC SRTx2].mkv',
    episode: 1,
    season: 3,
    kind: 'episode',
    titleIncludes: 'Kono Subarashii',
  },
  {
    label: 'Konosuba S2, season only present in a bracket',
    name: '[DHR&MakariHoshiyume][Konosuba S2][01][BIG5][720P][AVC_AAC].mp4',
    episode: 1,
    season: 2,
    kind: 'episode',
    titleIncludes: 'Konosuba',
  },
  {
    label: 'Non Non Biyori Repeat alias',
    name: '[KTXP][Non Non Biyori Repeat][01][GB][720P].mp4',
    episode: 1,
    season: 2,
    kind: 'episode',
    titleIncludes: 'Non Non Biyori',
  },
  {
    label: 'episode 00 prologue with v2',
    name: '[Comicat&KissSub][Mushoku Tensei II - Isekai Ittara Honki Dasu][00v2][1080P][GB][MP4].mp4',
    episode: 0,
    season: 2,
    kind: 'episode',
    titleIncludes: 'Mushoku Tensei',
  },
  {
    label: 'SP short marked with both an episode number and SP',
    name: '[JYFanSub][Shoujo_Shuumatsu_Ryokou][01][SP][GB][1080p][BDrip].mp4',
    episode: 1,
    season: null,
    kind: 'special',
    titleIncludes: 'Shoujo',
  },
  {
    label: 'Yuru Camp movie',
    name: '[Airota&Nekomoe kissaten][Yuru Camp Movie][UHDRip 2160p HEVC-10bit AAC][CHS].mp4',
    episode: null,
    season: null,
    kind: 'movie',
    titleIncludes: 'Yuru Camp',
  },
  {
    label: 'movie keyword inside free text + version suffix',
    name: '[Nekomoe kissaten&LoliHouse] Chou Kaguya-hime! - Movie v2 [WebRip 1080p HEVC-10bit AAC EAC3 ASSx2].mkv',
    episode: null,
    season: null,
    kind: 'movie',
    titleIncludes: 'Chou Kaguya',
  },
  {
    label: 'creditless ending (NCED)',
    name: "[LPSub] BanG Dream! It's MyGO!!!!! [BDRip][NCED][1080p][AVC AAC][JPSC].mp4",
    episode: null,
    season: null,
    kind: 'special',
    titleIncludes: 'BanG Dream',
  },
  {
    label: '2K WebRip with dash numbering',
    name: '[DMG&LoliHouse] Violet Evergarden - 01 [WebRip 2560x1440 HEVC-yuv420p10 EAC3].mkv',
    episode: 1,
    season: null,
    kind: 'episode',
    titleIncludes: 'Violet Evergarden',
  },
  {
    label: 'Roman numeral season followed by a full-width colon',
    name: '[Sakurato] Mushoku Tensei III： Isekai Ittara Honki Dasu [01][HEVC-10bit 1080P AAC][CHS&CHT].mkv',
    episode: 1,
    season: 3,
    kind: 'episode',
    titleIncludes: 'Mushoku Tensei',
  },
  {
    label: 'Nekomoe Chinese bracket title, Chinese episode range folder',
    name: '[Nekomoe kissaten][Make Heroine ga Oosugiru!][01][1080p][JPSC].mp4',
    episode: 1,
    season: null,
    kind: 'episode',
    titleIncludes: 'Make Heroine',
  },
  {
    label: 'half episode 11.5',
    name: '[DBD-Raws][孤独摇滚！][11.5][1080P][BDRip][HEVC-10bit][FLAC].mkv',
    episode: 11.5,
    season: null,
    kind: 'episode',
    titleIncludes: '孤独摇滚',
  },
  {
    label: 'final episode tagged 12END',
    name: '[Nekomoe kissaten][Make Heroine ga Oosugiru!][12END][1080p][JPSC].mp4',
    episode: 12,
    season: null,
    kind: 'episode',
    titleIncludes: 'Make Heroine',
  },
  {
    label: 'final episode with a space, 12 END',
    name: '[KTXP][Non Non Biyori Repeat][12 END][GB][720P].mp4',
    episode: 12,
    season: 2,
    kind: 'episode',
    titleIncludes: 'Non Non Biyori',
  },
];

for (const testCase of FILES) {
  test(`parse file: ${testCase.label}`, () => {
    const parsed = parseFileName(testCase.name);
    assert.equal(parsed.episode, testCase.episode, `episode of ${testCase.name}`);
    assert.equal(parsed.season, testCase.season, `season of ${testCase.name}`);
    assert.equal(parsed.kind, testCase.kind, `kind of ${testCase.name}`);
    if (testCase.titleIncludes) {
      assert.ok(
        parsed.title.toUpperCase().includes(testCase.titleIncludes.toUpperCase()),
        `title "${parsed.title}" should include "${testCase.titleIncludes}"`
      );
    }
  });
}

// Top-level series folders.
const FOLDERS = [
  ['从零开始的异世界生活S3', { season: 3, kind: 'episode' }],
  ['无职转生 第二季 ～到了异世界就拿出真本事～', { season: 2, kind: 'episode' }],
  ['无职转生 第三季 ～到了异世界就拿出真本事～', { season: 3, kind: 'episode' }],
  ['无职转生～到了异世界就拿出真本事～', { season: null, kind: 'episode' }],
  ['Re：从零开始的异世界生活 第四季 丧失篇', { season: 4, kind: 'episode' }],
  ['请问您今天要来点兔子吗？BLOOM', { season: 3, kind: 'episode' }],
  ['请问您今天要来点兔子吗？？', { season: null, kind: 'episode' }],
  ['悠哉日常大王 Repeat', { season: 2, kind: 'episode' }],
  ['悠哉日常大王 Nonstop', { season: 3, kind: 'episode' }],
  ['中二病也要谈恋爱剧场版', { season: null, kind: 'movie' }],
  ['Spy x Family 间谍过家家第三季', { season: 3, kind: 'episode' }],
  ['为美好的世界献上祝福', { season: null, kind: 'episode' }],
  ['孤独摇滚！', { season: null, kind: 'episode' }],
];

for (const [folder, expected] of FOLDERS) {
  test(`parse folder season: ${folder}`, () => {
    const parsed = parseFolderName(folder);
    assert.equal(parsed.season, expected.season, `season of ${folder}`);
    assert.equal(parsed.kind, expected.kind, `kind of ${folder}`);
  });
}

test('release folder: Konosuba S2 with an episode range', () => {
  const parsed = parseReleaseFolderName(
    '[DHR&MakariHoshiyume][Konosuba S2][01-10][BIG5][720P][AVC_AAC][MP4]'
  );
  assert.equal(parsed.season, 2);
  assert.deepEqual(parsed.episodeRange, { from: 1, to: 10 });
});

test('release folder: banG Dream batch range', () => {
  const parsed = parseReleaseFolderName(
    "[LPSub&LP-Raws] BanG Dream! It's MyGO!!!!! [BD 01-13 Fin][AVC AAC][1080p][JPSC]"
  );
  assert.deepEqual(parsed.episodeRange, { from: 1, to: 13 });
});

test('release folder: Re:Zero S3 2160p', () => {
  const parsed = parseReleaseFolderName('[Fyy Raws] Re0S3 Part1 2160p');
  assert.equal(parsed.season, 3);
});

test('release folder: Mushoku Tensei II two cours must not invent a season', () => {
  const parsed = parseReleaseFolderName(
    '[Comicat&KissSub] Mushoku Tensei II (00-12Fin WEBRip 1080p AVC AAC SC)'
  );
  assert.equal(parsed.season, 2);
});

test('findSeason does not mistake resolutions or years for seasons', () => {
  assert.equal(findSeason('[Airota][Gochuumon wa Usagi Desuka？？][1920x1080][AVC-YUV420P10_AAC]'), null);
  assert.equal(findSeason('[Sakurato] Spy x Family (2025) [01][HEVC-10bit 1080p AAC]'), null);
});

test('findEpisode ignores 1080p / 2160p resolutions', () => {
  assert.equal(findEpisode('[Fyy Raws] Re-Zero 4th Season [2160p AAC].mkv'), null);
  assert.equal(findEpisode('[Airota][Yuru Camp Movie][UHDRip 2160p HEVC-10bit AAC][CHS].mp4'), null);
});

test('similarity: exact and substring behaviour', () => {
  assert.equal(similarity('孤独摇滚！', '孤独摇滚'), 1);
  assert.ok(similarity('孤独摇滚！', '孤独摇滚！第二季') > 0.85);
  assert.ok(similarity('孤独摇滚', '紫罗兰永恒花园') < 0.2);
  assert.ok(similarity('SPY×FAMILY', 'Spy x Family (2025)') > 0.4);
});

test('normaliseName folds case, full-width characters and punctuation', () => {
  assert.equal(normaliseName('孤独摇滚！'), '孤独摇滚');
  assert.equal(normaliseName('Ｍｕｓｈｏｋｕ　Ｔｅｎｓｅｉ'), 'mushoku tensei');
  assert.equal(normaliseName('Re：从零开始 的异世界生活'), 're 从零开始 的异世界生活');
});

test('isVideoFile filters out fonts, subtitles and archives', () => {
  assert.ok(isVideoFile('a.mkv'));
  assert.ok(isVideoFile('B.MP4'));
  assert.ok(!isVideoFile('Fonts.7z'));
  assert.ok(!isVideoFile('subtitle.ass'));
  assert.ok(!isVideoFile('cover.jpg'));
  assert.ok(!isVideoFile('01 ふらふら.flac'));
});
