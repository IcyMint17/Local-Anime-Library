/**
 * Bangumi (bgm.tv) API client.
 *
 * Everything is cached in SQLite so a rescan never re-downloads metadata, and
 * all requests share one rate limiter because Bangumi asks clients to stay
 * around one request per second.
 */
import { requestJson, createRateLimiter } from '../net/http.js';

const BASE = 'https://api.bgm.tv';

/** Bangumi subject type 2 = anime. */
const ANIME_TYPE = 2;

/**
 * Bangumi gives every episode two numbers:
 *   `sort` — the continuous numbering across a whole series (无职转生 第二季 runs
 *            0..12 and its 第2部分 continues 13..24; Re:Zero 第四季 runs 67..77)
 *   `ep`   — the number printed on that particular entry (usually restarts at 1)
 * and a `type` where 0 = 本篇, 1 = SP, 2 = OP, 3 = ED, 4 = 预告, 6 = 其他.
 *
 * Local files are named with the continuous numbering, so `sort` is what we
 * match on — and what we show, because it is what Bangumi itself uses.
 */
export function mapEpisode(episode, index = 0) {
  const sort = Number(episode?.sort);
  const ep = Number(episode?.ep);
  const number = Number.isFinite(sort) ? sort : Number.isFinite(ep) ? ep : index + 1;
  const type = Number(episode?.type);
  return {
    number,
    sort: Number.isFinite(sort) ? sort : index + 1,
    ep: Number.isFinite(ep) ? ep : null,
    type: Number.isFinite(type) ? type : 0,
    title: episode?.name ?? null,
    title_cn: episode?.name_cn ?? null,
    air_date: episode?.airdate ?? episode?.air_date ?? null,
  };
}

/** 0 = 本篇, everything else (SP / OP / ED / PV / 其他) is extra content. */
export const isMainEpisodeType = (type) => Number(type ?? 0) === 0;

export const EPISODE_TYPE_LABEL = {
  0: '正片',
  1: '特别篇',
  2: 'OP',
  3: 'ED',
  4: '预告',
  5: 'MAD',
  6: '其他',
};

export class BangumiClient {
  constructor({ proxy = null, userAgent, accessToken = '', minIntervalMs = 1100, cache = null, logger = console } = {}) {
    this.proxy = proxy;
    this.userAgent = userAgent || 'anime-library/0.1 (local media manager)';
    this.accessToken = accessToken;
    this.cache = cache;
    this.logger = logger;
    this.limiter = createRateLimiter(minIntervalMs);
    this.requestCount = 0;
  }

  headers(extra = {}) {
    const headers = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...extra,
    };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    return headers;
  }

  async call(path, options = {}) {
    this.requestCount += 1;
    return this.limiter(() =>
      requestJson(`${BASE}${path}`, {
        proxy: this.proxy,
        headers: this.headers(options.headers),
        method: options.method ?? 'GET',
        json: options.json,
        timeoutMs: options.timeoutMs ?? 25000,
        retries: options.retries ?? 2,
      })
    );
  }

  /** Full-text search limited to anime subjects. */
  async searchSubjects(keyword, { limit = 12, useCache = true } = {}) {
    const trimmed = String(keyword ?? '').trim();
    if (!trimmed) return [];
    const key = `search:${trimmed}`;
    if (useCache && this.cache) {
      const cached = this.cache.get(key);
      if (Array.isArray(cached)) return cached;
    }
    const payload = await this.call('/v0/search/subjects', {
      method: 'POST',
      json: { keyword: trimmed, filter: { type: [ANIME_TYPE] } },
    });
    const data = Array.isArray(payload?.data) ? payload.data.slice(0, limit) : [];
    if (this.cache) this.cache.set(key, data);
    return data;
  }

  async getSubject(subjectId, { useCache = true } = {}) {
    const key = `subject:${subjectId}`;
    if (useCache && this.cache) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }
    const subject = await this.call(`/v0/subjects/${subjectId}`);
    if (this.cache) this.cache.set(key, subject);
    return subject;
  }

  /**
   * Official episode list, every type in one request (the API returns all types
   * when `type` is omitted). That is what lets a local file be recognised as an
   * SP because Bangumi says so, rather than because of its file name.
   */
  async getEpisodes(subjectId, { useCache = true } = {}) {
    // v2: the first version stored episodes under the wrong key names, so the
    // titles came back empty. v3 switched to `sort` numbering and started
    // fetching SP entries, so those caches have to go as well.
    const key = `episodes:v3:${subjectId}`;
    if (useCache && this.cache) {
      const cached = this.cache.get(key);
      if (Array.isArray(cached)) return cached;
    }
    const episodes = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const page = await this.call(
        `/v0/episodes?subject_id=${subjectId}&limit=${limit}&offset=${offset}`
      );
      const data = Array.isArray(page?.data) ? page.data : [];
      episodes.push(...data);
      const total = Number(page?.total ?? 0);
      offset += limit;
      if (data.length === 0 || offset >= total) break;
    }
    const mapped = episodes.map(mapEpisode);
    if (this.cache) this.cache.set(key, mapped);
    return mapped;
  }

  /** Normalises a subject payload into the shape the database stores. */
  static normaliseSubject(subject) {
    const images = subject.images ?? {};
    return {
      bangumi_id: subject.id,
      title_cn: subject.name_cn || subject.name || null,
      title_orig: subject.name ?? null,
      summary: subject.summary ?? null,
      air_date: subject.date ?? null,
      eps_total: Number.isFinite(subject.eps) && subject.eps > 0 ? subject.eps : null,
      cover_url: images.large ?? images.common ?? images.medium ?? images.grid ?? null,
      rating: subject.rating?.score ?? null,
      rating_count: subject.rating?.total ?? null,
    };
  }

  /**
   * Alternate titles only — staff/studio infobox rows are ignored, otherwise
   * every subject would "match" the animator credited on it.
   */
  static extractAliases(subject) {
    const KEYS = /别名|別名|中文名|英文名|日文名|罗马音|羅馬音|罗马字|譯名|译名|其他译名|简称|別称|别称/;
    const aliases = [];
    for (const item of subject?.infobox ?? []) {
      if (!KEYS.test(String(item?.key ?? ''))) continue;
      const values = Array.isArray(item.value) ? item.value.map((entry) => entry?.v ?? entry) : [item.value];
      for (const value of values) {
        if (typeof value === 'string' && value.trim()) aliases.push(value.trim());
      }
    }
    return [...new Set(aliases)];
  }
}
