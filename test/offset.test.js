import test from 'node:test';
import assert from 'node:assert/strict';

import { detectEpisodeOffset, describeMapping, isValidOffset, MAX_OFFSET } from '../src/library/offset.js';

const range = (from, to, step = 1) => {
  const out = [];
  for (let value = from; value <= to; value += step) out.push(value);
  return out;
};

test('absolute numbering: Re:Zero 第四季 local 67-76 maps onto Bangumi 1-11', () => {
  const result = detectEpisodeOffset(range(67, 76), range(1, 11));
  assert.equal(result.offset, -66);
  assert.equal(result.matched, 10);
  assert.equal(result.coverage, 1);
  assert.equal(result.detected, true);
});

test('zero-based numbering: 无职转生 第二季 local 0-24 maps onto Bangumi 1-13', () => {
  const result = detectEpisodeOffset(range(0, 24), range(1, 13));
  assert.equal(result.offset, 1, 'the 00 file is episode 1');
  assert.equal(result.matched, 13);
  assert.equal(result.detected, true);
});

test('already aligned numbering is left alone', () => {
  const result = detectEpisodeOffset(range(1, 12), range(1, 12));
  assert.equal(result.offset, 0);
  assert.equal(result.detected, false);
  assert.equal(result.reason, 'aligned');
});

test('extra local episodes never shift the mapping', () => {
  // Re:Zero 第三季: we own 15 episodes, Bangumi lists 8 for 襲擊編.
  assert.equal(detectEpisodeOffset(range(1, 15), range(1, 8)).offset, 0);
  // 无职转生 第一季: we own 24 (two cours), Bangumi lists 11 for the first.
  assert.equal(detectEpisodeOffset(range(1, 24), range(1, 11)).offset, 0);
  // 孤独摇滚: 12 episodes plus a 11.5 half episode.
  assert.equal(detectEpisodeOffset([...range(1, 12), 11.5], range(1, 12)).offset, 0);
});

test('a local suffix of the Bangumi list stays at offset 0', () => {
  assert.equal(detectEpisodeOffset(range(5, 12), range(1, 12)).offset, 0);
  assert.equal(detectEpisodeOffset([12], range(1, 12)).offset, 0);
});

test('a second cour numbered continuously is shifted back onto its own subject', () => {
  // 无职转生 第二季 第2部分 is a separate Bangumi subject numbered 1-12, while the
  // local files keep counting 13-24.
  const result = detectEpisodeOffset(range(13, 24), range(1, 12));
  assert.equal(result.offset, -12);
  assert.equal(result.matched, 12);
  assert.equal(result.detected, true);
});

test('a local suffix inside the Bangumi range is not shifted', () => {
  assert.equal(detectEpisodeOffset(range(13, 24), range(1, 24)).offset, 0);
});

test('missing data degrades to offset 0 instead of guessing', () => {
  assert.equal(detectEpisodeOffset([], range(1, 12)).offset, 0);
  assert.equal(detectEpisodeOffset(range(1, 12), []).offset, 0);
  assert.equal(detectEpisodeOffset([null, undefined, NaN], range(1, 12)).offset, 0);
  assert.equal(detectEpisodeOffset(range(1, 12), []).reason, 'no-episodes');
});

test('a single stray episode is not enough to move the mapping', () => {
  // 7 lines up, 40 does not, and one match is below the confidence floor.
  const result = detectEpisodeOffset([7, 40], range(1, 12));
  assert.equal(result.offset, 0);
  assert.equal(result.detected, false);
  assert.equal(result.reason, 'no-confident-mapping');
});

test('a single episode that is already in range stays put', () => {
  const result = detectEpisodeOffset([7], range(1, 12));
  assert.equal(result.offset, 0);
  assert.equal(result.detected, false);
});

test('detection is idempotent: re-running on a mapped set returns the same offset', () => {
  const local = range(67, 76);
  const bangumi = range(1, 11);
  const first = detectEpisodeOffset(local, bangumi);
  const shifted = local.map((n) => n + first.offset);
  assert.equal(detectEpisodeOffset(shifted, bangumi).offset, 0);
});

test('describeMapping and offset validation', () => {
  assert.equal(describeMapping(0), '一一对应');
  assert.equal(describeMapping(-66), '本地集号 − 66');
  assert.equal(describeMapping(1), '本地集号 + 1');
  assert.ok(isValidOffset(0));
  assert.ok(isValidOffset(-66));
  assert.ok(!isValidOffset(MAX_OFFSET + 1));
  assert.ok(!isValidOffset(1.5));
  assert.ok(!isValidOffset('nope'));
});
