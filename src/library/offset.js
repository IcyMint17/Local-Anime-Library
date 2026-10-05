/**
 * Works out how local episode numbers line up with Bangumi episode numbers.
 *
 * Real cases this has to get right:
 *   无职转生 第二季   local 0..24  vs Bangumi 1..13  →  +1  (the 00 file is episode 1)
 *   Re:Zero 第四季    local 67..76 vs Bangumi 1..11  →  -66 (absolute numbering)
 *   孤独摇滚！        local 1..12 + 11.5 vs 1..12    →   0
 *   Re:Zero 第三季    local 1..15 vs Bangumi 1..8    →   0  (we simply own extra episodes)
 *
 * The rule is "maximise how many local episodes land on a Bangumi episode",
 * then prefer the mapping that lines the two sequences up at the start.
 */

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export function detectEpisodeOffset(localNumbers, bangumiNumbers) {
  const local = [...new Set((localNumbers ?? []).filter(isNumber))].sort((a, b) => a - b);
  const bangumi = [...new Set((bangumiNumbers ?? []).filter(isNumber))].sort((a, b) => a - b);

  if (local.length === 0 || bangumi.length === 0) {
    return { offset: 0, matched: 0, localTotal: local.length, coverage: 0, detected: false, reason: 'no-episodes' };
  }

  const bangumiSet = new Set(bangumi);
  const hitsAt = (offset) => local.reduce((total, number) => total + (bangumiSet.has(number + offset) ? 1 : 0), 0);

  // Already aligned — never touch a mapping that covers everything.
  if (hitsAt(0) === local.length) {
    return { offset: 0, matched: local.length, localTotal: local.length, coverage: 1, detected: false, reason: 'aligned' };
  }

  // Every offset implied by a (local, bangumi) pair is a candidate.
  const candidates = new Set();
  for (const number of local) {
    for (const target of bangumi) candidates.add(target - number);
  }

  const localMin = local[0];
  const bangumiMin = bangumi[0];
  let best = null;

  for (const offset of candidates) {
    const matched = hitsAt(offset);
    const alignGap = Math.abs(localMin + offset - bangumiMin);
    const magnitude = Math.abs(offset);
    const better =
      !best ||
      matched > best.matched ||
      (matched === best.matched && alignGap < best.alignGap) ||
      (matched === best.matched && alignGap === best.alignGap && magnitude < best.magnitude);
    if (better) best = { offset, matched, alignGap, magnitude };
  }

  // Require a real signal: at least two episodes and at least half of the local
  // files landing on a Bangumi episode. 无职转生 第二季 sits right on this line
  // (13 of 25, because the folder also carries the second cour).
  const goodEnough = best.matched >= Math.max(2, Math.ceil(local.length * 0.5));
  if (!best || !goodEnough) {
    return { offset: 0, matched: hitsAt(0), localTotal: local.length, coverage: 0, detected: false, reason: 'no-confident-mapping' };
  }

  return {
    offset: best.offset,
    matched: best.matched,
    localTotal: local.length,
    coverage: best.matched / local.length,
    detected: true,
    reason: 'overlap',
  };
}

/** Human-readable description of a mapping, e.g. 本地 67 → Bangumi 1. */
export function describeMapping(offset) {
  if (!offset) return '一一对应';
  return offset > 0 ? `本地集号 + ${offset}` : `本地集号 − ${Math.abs(offset)}`;
}

/** Sanity bound so a typo can never produce a wildly wrong offset. */
export const MAX_OFFSET = 9999;
export const isValidOffset = (value) => Number.isInteger(value) && Math.abs(value) <= MAX_OFFSET;
