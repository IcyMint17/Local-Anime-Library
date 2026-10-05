/**
 * Scores Bangumi search hits against a local group and decides whether the
 * match is confident enough to apply automatically.
 */
import { similarity, findSeason } from '../scan/parse.js';
import { BangumiClient } from './bangumi.js';

/** Punctuation-preserving form, used to tell "吗？" and "吗？？" apart. */
const loose = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, '').trim();

export const WEIGHTS = {
  name: 0.45,
  season: 0.25,
  kind: 0.15,
  episodes: 0.05,
  quality: 0.08,
  rank: 0.1,
  punctuation: 0.1,
};

const MAX_RAW_SCORE =
  WEIGHTS.name + WEIGHTS.season + WEIGHTS.kind + WEIGHTS.episodes + WEIGHTS.quality + WEIGHTS.rank + WEIGHTS.punctuation;

function seasonFactor(season, subjectSeason) {
  if (season == null) {
    // We believe this is a first season (or unknown). Later seasons should not win.
    if (subjectSeason != null && subjectSeason > 1) return 0.15;
    return 0.6;
  }
  if (subjectSeason == null) return 0.2;
  return subjectSeason === season ? 1 : 0;
}

/** A group that says "season 3" must never silently bind to season 1 or 4. */
function hasSeasonConflict(season, subjectSeason) {
  if (season == null) return false;
  return subjectSeason == null || subjectSeason !== season;
}

function kindFactor(kind, epsTotal) {
  if (kind === 'movie') return epsTotal === 1 ? 1 : 0;
  if (kind === 'special') return 0.5;
  if (epsTotal == null) return 0.5;
  return epsTotal >= 2 ? 1 : 0;
}

function episodeFactor(episodeCount, epsTotal) {
  if (!episodeCount || !epsTotal) return 0.5;
  const difference = Math.abs(episodeCount - epsTotal);
  return Math.max(0, 1 - difference / Math.max(episodeCount, epsTotal));
}

/**
 * @param {object} args
 * @param {object} args.subject Raw Bangumi search hit.
 * @param {string[]} args.queries Local title hints, best first.
 * @param {number} args.rank Zero-based position of this hit in the search results.
 * @param {number|null} args.season
 * @param {string} args.kind Local group kind: episode | movie | special.
 * @param {number} args.episodeCount Local episode count.
 */
export function scoreCandidate({
  subject,
  queries,
  rank = 0,
  season = null,
  kind = 'episode',
  episodeCount = 0,
  aliases = [],
}) {
  const names = [subject.name_cn, subject.name, ...aliases].filter(Boolean);
  const epsTotal = Number.isFinite(subject.eps) && subject.eps > 0 ? subject.eps : null;

  let nameScore = 0;
  let punctuationBonus = 0;
  for (const query of queries) {
    for (const name of names) {
      nameScore = Math.max(nameScore, similarity(query, name));
      if (loose(query) && loose(query) === loose(name)) punctuationBonus = WEIGHTS.punctuation;
    }
  }

  const subjectSeason = findSeason(`${subject.name_cn ?? ''} ${subject.name ?? ''}`);
  const seasonValue = seasonFactor(season, subjectSeason);
  const kindValue = kindFactor(kind, epsTotal);
  const episodeValue = kind === 'movie' ? 0.5 : episodeFactor(episodeCount, epsTotal);
  const qualityValue =
    (subject.date ? 0.5 : 0) + ((subject.rating?.total ?? 0) > 0 ? 0.5 : 0);
  const rankValue = Math.max(0, WEIGHTS.rank - rank * 0.025);

  const score =
    WEIGHTS.name * nameScore +
    WEIGHTS.season * seasonValue +
    WEIGHTS.kind * kindValue +
    WEIGHTS.episodes * episodeValue +
    WEIGHTS.quality * qualityValue +
    rankValue +
    punctuationBonus;

  const conflict = hasSeasonConflict(season, subjectSeason);
  const normalised = (conflict ? score * 0.6 : score) / MAX_RAW_SCORE;

  return {
    score: Math.max(0, Math.min(1, normalised)),
    nameScore,
    subjectSeason,
    seasonConflict: conflict,
    parts: { seasonValue, kindValue, episodeValue, qualityValue, rankValue, punctuationBonus },
  };
}

/**
 * Searches with every query hint and returns the ranked candidate list.
 * @returns {{candidates:Array<object>, best:object|null, margin:number, confident:boolean}}
 */
export async function findMatches(client, group, options = {}) {
  const {
    threshold = 0.7,
    margin: marginThreshold = 0.06,
    maxQueries = 3,
    limit = 12,
    enrichLimit = 8,
  } = options;
  const queries = (group.titleCandidates ?? []).slice(0, maxQueries);
  const collected = new Map();
  const baseArgs = {
    queries,
    season: group.season ?? null,
    kind: group.kind ?? 'episode',
    episodeCount: group.episodeCount ?? 0,
  };

  for (const query of queries) {
    let hits = [];
    try {
      hits = await client.searchSubjects(query, { limit });
    } catch (error) {
      client.logger?.warn?.(`搜索 "${query}" 失败: ${error.message}`);
      continue;
    }
    if (!Array.isArray(hits)) continue;
    hits.forEach((subject, index) => {
      const scored = scoreCandidate({
        subject,
        rank: index,
        ...baseArgs,
      });
      const existing = collected.get(subject.id);
      if (!existing || scored.score > existing.score) {
        collected.set(subject.id, {
          ...subject,
          score: Number(scored.score.toFixed(4)),
          detail: scored,
          bestQuery: query,
          bestRank: index,
        });
      }
    });
  }

  let candidates = [...collected.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  let best = candidates[0] ?? null;
  let runnerUp = candidates[1] ?? null;
  const margin = best && runnerUp ? best.score - runnerUp.score : best ? best.score : 0;
  let confident = Boolean(best) && best.score >= threshold && margin >= marginThreshold;

  // Second pass: when the search alone is not convincing, pull the full subject
  // records and re-score with their alternate titles. This is what lets a folder
  // called "GIRLS BAND CRY" bind to 少女乐队的呐喊, whose Bangumi entry lists
  // "GIRLS BAND CRY" as an alias.
  if (!confident && candidates.length > 0) {
    for (const candidate of candidates.slice(0, enrichLimit)) {
      try {
        const detail = await client.getSubject(candidate.id);
        const aliases = BangumiClient.extractAliases(detail);
        const merged = { ...candidate, ...detail };
        const rescored = scoreCandidate({ subject: merged, rank: candidate.bestRank, aliases, ...baseArgs });
        candidate.score = Number(rescored.score.toFixed(4));
        candidate.detail = rescored;
        candidate.aliases = aliases;
        candidate.name_cn = merged.name_cn;
        candidate.name = merged.name;
        candidate.eps = merged.eps;
        candidate.date = merged.date;
        candidate.rating = merged.rating;
        candidate.images = merged.images;
      } catch {
        // A single failed detail lookup must not kill the whole match attempt.
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    best = candidates[0] ?? null;
    runnerUp = candidates[1] ?? null;
    const nextMargin = best && runnerUp ? best.score - runnerUp.score : best ? best.score : 0;
    confident = Boolean(best) && best.score >= threshold && nextMargin >= marginThreshold;
  }

  return {
    candidates,
    best,
    margin: best && runnerUp ? best.score - runnerUp.score : best ? best.score : 0,
    confident,
  };
}
