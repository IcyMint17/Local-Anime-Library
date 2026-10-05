import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNumber, countMatched, matchLocalToBangumi } from '../src/library/mapping.js';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

test('resolveNumber applies the offset when it lands on a real episode', () => {
  const bangumi = new Set(range(1, 3));
  assert.equal(resolveNumber(0, 1, bangumi), 1);
  assert.equal(resolveNumber(1, 1, bangumi), 2);
  assert.equal(resolveNumber(2, 1, bangumi), 3);
});

test('resolveNumber falls back to the raw number when the offset lands nowhere', () => {
  // Re:Zero 第三季: local 01..14 belong to sort 51..64, but the file named 66END
  // is already the right number.
  const bangumi = new Set(range(51, 66));
  assert.equal(resolveNumber(1, 50, bangumi), 51);
  assert.equal(resolveNumber(14, 50, bangumi), 64);
  assert.equal(resolveNumber(66, 50, bangumi), 66, '66+50 is nonsense, 66 is correct');
});

test('resolveNumber leaves genuinely unmapped episodes alone', () => {
  const bangumi = new Set(range(1, 12));
  assert.equal(resolveNumber(11.5, 0, bangumi), 11.5, 'a half episode not on Bangumi stays unmapped');
  assert.equal(resolveNumber(40, 0, bangumi), 40);
});

test('countMatched understands both the offset and the raw-number fallback', () => {
  const bangumi = range(51, 66);
  assert.equal(countMatched([1, 2, 3, 66], bangumi, 50), 4);
  assert.equal(countMatched([1, 2, 3, 99], bangumi, 50), 3);
});

test('a folder numbered from 0 still shifts every episode', () => {
  const bangumi = range(1, 13);
  const local = range(0, 12);
  const mapped = local.map((number) => resolveNumber(number, 1, new Set(bangumi)));
  assert.deepEqual(mapped, range(1, 13));
  assert.equal(countMatched(local, bangumi, 1), 13);
});

const bangumiEpisode = (number, type = 0, title = `ep ${number}`) => ({
  number,
  type,
  title,
  title_cn: title,
});

test('a main episode wins over a special that reuses the same number', () => {
  // 孤独摇滚！ has main episodes 1..12 plus SPs also numbered 1, 2, 3 and 11.5.
  const episodes = [
    bangumiEpisode(1, 0, '翻转孤独'),
    bangumiEpisode(2, 0, '明天见'),
    bangumiEpisode(3, 0, '火速增员'),
    bangumiEpisode(11), 
    bangumiEpisode(12),
    bangumiEpisode(1, 1, 'ABEMA 特别节目'),
    bangumiEpisode(2, 1, '放送直前特番'),
    bangumiEpisode(3, 1, 'とーく！'),
    bangumiEpisode(11.5, 1, '后藤双的姐姐观察日记'),
  ];
  const pairs = matchLocalToBangumi([1, 2, 3, 11.5, 12], episodes, 0);

  assert.equal(pairs.get(1).type, 0, 'local [01] is the real episode, not the SP');
  assert.equal(pairs.get(1).title_cn, '翻转孤独');
  assert.equal(pairs.get(3).type, 0);
  assert.equal(pairs.get(11.5).type, 1, 'the 11.5 half episode is the SP');
  assert.equal(pairs.get(11.5).title_cn, '后藤双的姐姐观察日记');
});

test('a local number with no main episode falls back to the specials numbering', () => {
  // 无职转生 第2部分: main 12..23, and an SP at 24.
  const episodes = [...range(12, 23).map((n) => bangumiEpisode(n)), bangumiEpisode(24, 1, '艾莉丝的哥布林讨伐')];
  const pairs = matchLocalToBangumi([12, 13, 24], episodes, 0);
  assert.equal(pairs.get(12).type, 0);
  assert.equal(pairs.get(24).type, 1);
  assert.equal(pairs.get(24).title_cn, '艾莉丝的哥布林讨伐');
});

test('unmatched local numbers stay unpairable', () => {
  const episodes = range(1, 12).map((n) => bangumiEpisode(n));
  const pairs = matchLocalToBangumi([1, 40], episodes, 0);
  assert.equal(pairs.size, 1);
  assert.equal(pairs.has(40), false);
});

test('a hand-pinned mapping is applied literally, without the raw-number fallback', () => {
  // Bangumi only lists 12 and 13, so offset -11 points at nothing for local 12.
  const episodes = [bangumiEpisode(12), bangumiEpisode(13)];

  const auto = matchLocalToBangumi([12], episodes, -11, { allowRawFallback: true });
  assert.equal(auto.get(12).number, 12, 'the fallback trusts 12 because Bangumi has it');

  const manual = matchLocalToBangumi([12], episodes, -11, { allowRawFallback: false });
  assert.equal(manual.has(12), false, 'a pinned mapping is taken at face value');

  // When the pinned offset does land on an episode, it is used.
  const pinned = matchLocalToBangumi([12, 13], episodes, 0, { allowRawFallback: false });
  assert.equal(pinned.get(12).number, 12);
  assert.equal(pinned.get(13).number, 13);
});
