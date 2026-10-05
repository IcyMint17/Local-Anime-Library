/**
 * Scan -> group -> match -> persist.
 *
 * The pipeline is deliberately resumable: anything already matched stays
 * matched, manual corrections are never overwritten, and a failed metadata
 * lookup never removes files from the library.
 */
import path from 'node:path';
import { walkVideos } from './walk.js';
import { groupFiles } from './group.js';
import { findMatches } from '../meta/matcher.js';
import { ensureCover } from '../meta/covers.js';
import { syncEpisodes } from '../library/parts.js';
import * as repo from '../db/repo.js';

export function localKeyFor(group) {
  return `${group.rootDir}|${group.sourceFolder}|${group.season ?? 'x'}`;
}

async function persistGroup({ db, group, outcome, config, client, existing, coversDir }) {
  const localKey = localKeyFor(group);
  let seriesId = existing?.id ?? null;
  let matchState = existing?.match_state ?? 'unmatched';
  let subject = null;

  if (!seriesId) {
    seriesId = repo.insertSeries(db, {
      local_key: localKey,
      source_folder: group.sourceFolder,
      title_cn: group.title,
      media_kind: group.kind,
      season: group.season,
      match_state: 'unmatched',
    });
  }

  const wantsMatch = !existing || existing.match_state === 'unmatched';
  if (wantsMatch && outcome) {
    repo.replaceCandidates(db, seriesId, outcome.candidates);
    if (outcome.confident && outcome.best) {
      subject = outcome.best;
      matchState = 'auto';
    }
  } else if (existing?.bangumi_id) {
    repo.replaceCandidates(db, seriesId, outcome?.candidates ?? []);
  }

  // Files first: they are the only thing we can never re-download.
  const fileIds = new Map();
  for (const item of group.files) {
    const id = repo.upsertFile(db, seriesId, {
      path: item.file.path,
      name: item.file.name,
      ext: item.file.ext,
      size: item.file.size,
      mtime: item.file.mtime,
      kind: item.parsed.kind,
      season: item.season ?? group.season,
      ep_number: item.parsed.episode,
      ep_label: item.parsed.episodeLabel,
      confidence: item.parsed.confidence,
    });
    fileIds.set(item.file.path, id);
  }
  repo.markMissingFiles(db, seriesId, [...fileIds.keys()]);

  if (subject) {
    repo.updateSeries(db, seriesId, {
      bangumi_id: subject.id ?? null,
      title_cn: subject.name_cn || subject.name || group.title,
      title_orig: subject.name ?? null,
      summary: subject.summary ?? null,
      air_date: subject.date ?? null,
      eps_total: Number.isFinite(subject.eps) && subject.eps > 0 ? subject.eps : null,
      cover_url: subject.images?.large ?? subject.images?.common ?? subject.images?.grid ?? null,
      rating: subject.rating?.score ?? null,
      rating_count: subject.rating?.total ?? null,
      media_kind: group.kind,
      season: group.season,
      match_state: matchState,
      match_score: subject.score ?? null,
    });
  } else if (matchState === 'unmatched') {
    repo.updateSeries(db, seriesId, {
      title_cn: existing?.title_cn ?? group.title,
      media_kind: group.kind,
      season: group.season,
      match_state: 'unmatched',
    });
  }

  // Bangumi episode list + cover for everything that is bound.
  const current = repo.getSeries(db, seriesId);
  if (current?.bangumi_id && matchState !== 'unmatched') {
    try {
      // Pulls every Bangumi part the folder covers, works out the local↔Bangumi
      // numbering, and re-classifies files that Bangumi marks as SP.
      await syncEpisodes({
        db,
        client,
        series: current,
        query: group.titleCandidates[0] ?? group.sourceFolder,
        logger: client.logger,
      });
    } catch (error) {
      client.logger?.warn?.(`同步 ${current.title_cn} 的剧集列表失败: ${error.message}`);
    }
    let detail = null;
    try {
      detail = await client.getSubject(current.bangumi_id);
    } catch {
      detail = null;
    }
    const cover = await ensureCover({
      subject: detail ?? { id: current.bangumi_id, images: { large: current.cover_url } },
      coversDir,
      proxy: client.proxy,
      userAgent: client.userAgent,
    });
    if (cover) repo.updateSeries(db, seriesId, { cover_path: path.basename(cover) });
    if (detail?.summary) repo.updateSeries(db, seriesId, { summary: detail.summary });
  }

  return { seriesId, matchState };
}

/**
 * @returns {Promise<object>} A summary of the run.
 */
export async function runScan({ db, config, client, coversDir, onProgress = () => {} }) {
  const runId = repo.startScanRun(db);
  const started = Date.now();
  const allGroups = [];
  const walkErrors = [];
  let filesSeen = 0;
  let skipped = 0;

  for (const dir of config.scan.dirs) {
    if (!dir) continue;
    onProgress({ phase: 'walk', dir });
    const result = await walkVideos(dir, { ignoreDirNames: config.scan.ignoreDirNames });
    filesSeen += result.files.length;
    skipped += result.skippedFiles;
    walkErrors.push(...result.errors);
    allGroups.push(
      ...groupFiles(result.files, { rootName: path.basename(dir), root: dir })
    );
  }

  // Drop groups that vanished from disk (their folder no longer has any video).
  const liveKeys = new Set(allGroups.map((group) => localKeyFor(group)));
  for (const series of repo.listSeries(db)) {
    if (series.local_key && !liveKeys.has(series.local_key)) {
      repo.deleteSeries(db, series.id);
    }
  }

  let matched = 0;
  let unmatched = 0;
  let index = 0;

  for (const group of allGroups) {
    index += 1;
    const localKey = localKeyFor(group);
    const existing = repo.findSeriesByLocalKey(db, localKey);
    onProgress({
      phase: 'match',
      index,
      total: allGroups.length,
      folder: group.sourceFolder,
      season: group.season,
    });

    let outcome = null;
    if (!existing || existing.match_state === 'unmatched') {
      outcome = await findMatches(client, group, {
        threshold: config.metadata.matchThreshold,
        margin: config.metadata.matchMargin,
      });
    }

    const saved = await persistGroup({ db, group, outcome, config, client, existing, coversDir });
    if (saved.matchState === 'unmatched') unmatched += 1;
    else matched += 1;
  }

  const summary = {
    filesSeen,
    groups: allGroups.length,
    matched,
    unmatched,
    skipped,
    walkErrors,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    apiCalls: client.requestCount,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
  };
  repo.finishScanRun(db, runId, {
    filesSeen,
    groups: allGroups.length,
    matched,
    unmatched,
    note: `${walkErrors.length} 个目录读取失败, 跳过 ${skipped} 个非视频文件`,
  });
  return summary;
}
