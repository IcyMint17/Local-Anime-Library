/**
 * Groups loose video files into library entries.
 *
 * A "group" is one Bangumi subject's worth of files. Most of the time that is
 * just a top-level folder, but a single folder can hold two seasons
 * (e.g. "为美好的世界献上祝福" contains Konosuba S2 and S3), so files are
 * additionally split by the season detected in their release folder / file name.
 */
import path from 'node:path';
import {
  parseFileName,
  parseFolderName,
  parseReleaseFolderName,
  normaliseName,
  cleanupTitle,
  isExtraFolderName,
} from './parse.js';

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    const key = normaliseName(value);
    if (!key) continue;
    const entry = counts.get(key) ?? { value, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.value ?? null;
}

function uniqueByNormalised(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (!value) continue;
    const key = normaliseName(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

/**
 * @param {Array<object>} files Output of walkVideos().
 * @param {{rootName?:string}} options
 */
export function groupFiles(files, options = {}) {
  const { rootName = '未分组' } = options;

  // 1. Bucket by top-level series folder.
  const bySeries = new Map();
  for (const file of files) {
    const segments = file.relSegments;
    const seriesName = segments.length > 1 ? segments[0] : `${rootName}`;
    if (!bySeries.has(seriesName)) bySeries.set(seriesName, []);
    bySeries.get(seriesName).push(file);
  }

  const groups = [];

  for (const [seriesName, seriesFiles] of bySeries) {
    const folder = parseFolderName(seriesName);

    // 2. Parse every file, preferring the file's own markers, then its release
    //    folder, then the series folder.
    const enriched = seriesFiles.map((file) => {
      const parsed = parseFileName(file.name);
      const releaseSegments = file.relSegments.slice(1, -1);
      const releaseName = releaseSegments.length > 0 ? releaseSegments[releaseSegments.length - 1] : null;
      const release = releaseName ? parseReleaseFolderName(releaseName) : null;
      const season = parsed.season ?? release?.season ?? folder.season ?? null;
      const part = parsed.part ?? release?.part ?? folder.part ?? null;
      return { file, parsed, releaseName, season, part };
    });

    // 3. Everything sitting in a sub-folder below the main release folder is
    //    extra content (孤独摇滚！ hides 歌曲欣赏 / 吉他英雄之路 / 谈话 there).
    const mainDepth = Math.min(...enriched.map((item) => item.file.relDirSegments.length));
    for (const item of enriched) {
      if (item.parsed.kind !== 'episode') continue;
      const extraSegments = item.file.relDirSegments.slice(mainDepth);
      if (extraSegments.length > 0 && extraSegments.some(isExtraFolderName)) {
        item.parsed = { ...item.parsed, kind: 'special' };
      }
    }

    // 4. Split when the folder really holds more than one season.
    const seasons = [...new Set(enriched.map((item) => item.season).filter((value) => value != null))].sort(
      (a, b) => a - b
    );
    const dominantSeason = seasons.length === 1 ? seasons[0] : folder.season ?? null;

    const buckets = new Map();
    if (seasons.length >= 2) {
      for (const item of enriched) {
        const season = item.season ?? dominantSeason ?? 0;
        if (!buckets.has(season)) buckets.set(season, []);
        buckets.get(season).push(item);
      }
    } else {
      buckets.set(seasons[0] ?? folder.season ?? 0, enriched);
    }

    for (const [seasonKey, items] of buckets) {
      const season = seasonKey === 0 ? null : seasonKey;
      // Prefer the title derived from real episodes; extra sub-folders like
      // "吉他英雄之路" would otherwise win the vote and pollute the search query.
      const episodeItems = items.filter((item) => item.parsed.kind === 'episode');
      const hasMovie = items.some((item) => item.parsed.kind === 'movie');

      // A folder whose only episode-like file carries no episode number at all
      // is a film. 小林家的龙女仆 怕寂寞的龙 has neither 剧场版 nor "Movie" in the
      // folder or the file name; calling it an episode left it with zero
      // episodes *and* hid the file from the detail view.
      const loneUnnumbered = episodeItems.length === 1 && episodeItems[0].parsed.episode == null;

      let kind = 'episode';
      if (folder.kind === 'movie') kind = 'movie';
      else if (episodeItems.length === 0) kind = hasMovie ? 'movie' : 'special';
      else if (loneUnnumbered) kind = 'movie';

      // The file row has to agree with the group: the detail view decides
      // between 正片 / 特别篇 / 剧场版 from the file's own kind, so leaving the
      // film as an "episode with no number" kept it out of every list.
      if (kind === 'movie' && loneUnnumbered) {
        episodeItems[0].parsed = { ...episodeItems[0].parsed, kind: 'movie' };
      }

      // Every distinct file title is a search hint: fan-sub file names usually
      // carry the original or romaji title even when the folder does not.
      const itemTitles = (episodeItems.length ? episodeItems : items).map((item) => item.parsed.title);
      const fileTitles = uniqueByNormalised([mostCommon(itemTitles), ...itemTitles]).slice(0, 2);
      const releaseTitles = uniqueByNormalised(
        (episodeItems.length ? episodeItems : items).map((item) => item.releaseName)
      );

      // Query hints for Bangumi. The raw folder name comes first because it
      // usually carries the Chinese title *and* the season marker
      // ("无职转生 第二季 ～…～"), which is exactly what the search API matches on.
      const titleCandidates = uniqueByNormalised([
        seriesName,
        ...fileTitles,
        ...releaseTitles.map((name) => parseFileName(name).title),
      ]).slice(0, 4);

      // Episode statistics must only consider real episodes. Specials and
      // creditless OP/EDs are frequently numbered from 01 again, which would
      // otherwise inflate the count (孤独摇滚！ has 48 extras numbered like episodes).
      const episodeNumbers = items
        .filter((item) => item.parsed.kind === 'episode')
        .map((item) => item.parsed.episode)
        .filter((value) => value != null)
        .sort((a, b) => a - b);

      groups.push({
        key: `${seriesName}::${season ?? 'x'}`,
        rootDir: options.root ?? '',
        sourceFolder: seriesName,
        sourceDir: items[0].file.relDirSegments.length
          ? path.join(options.root ?? '', items[0].file.relDirSegments[0])
          : options.root ?? '',
        title: folder.title || seriesName,
        titleCandidates,
        season,
        part: items[0].part ?? null,
        kind,
        files: items,
        episodeCount: new Set(episodeNumbers).size,
        minEpisode: episodeNumbers.length ? episodeNumbers[0] : null,
        maxEpisode: episodeNumbers.length ? episodeNumbers[episodeNumbers.length - 1] : null,
      });
    }
  }

  groups.sort((a, b) => a.sourceFolder.localeCompare(b.sourceFolder, 'zh-Hans-CN'));
  return groups;
}
