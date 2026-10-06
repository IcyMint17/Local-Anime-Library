#!/usr/bin/env node
/**
 * Dev tool: run the real matcher against a real library and print a report.
 * Usage: node tools/evaluate-matching.mjs [libraryRoot]
 */
import { loadConfig, resolveProxy } from '../src/config.js';
import { walkVideos } from '../src/scan/walk.js';
import { groupFiles } from '../src/scan/group.js';
import { BangumiClient } from '../src/meta/bangumi.js';
import { findMatches } from '../src/meta/matcher.js';
import { openDatabase } from '../src/db/repo.js';
import { getCache, setCache } from '../src/db/repo.js';
import { DB_PATH } from '../src/config.js';

const root = process.argv[2] ?? 'E:\\Videos\\Anime';
const verbose = process.argv.includes('--verbose');

const config = loadConfig();
const { proxy, source } = await resolveProxy(config, { force: !config.resolvedProxy, verbose });
console.log(`代理: ${proxy ?? '直连'} (${source})\n`);

const db = openDatabase(DB_PATH);
const cache = { get: (key) => getCache(db, key)?.value ?? null, set: (key, value) => setCache(db, key, value) };
const client = new BangumiClient({
  proxy,
  userAgent: config.metadata.userAgent,
  accessToken: config.metadata.accessToken,
  minIntervalMs: config.metadata.requestIntervalMs,
  cache,
  logger: { warn: (message) => console.warn(`  ! ${message}`) },
});

const { files } = await walkVideos(root, { ignoreDirNames: config.scan.ignoreDirNames });
const groups = groupFiles(files, { rootName: root.split(/[\\/]/).pop() });

const started = Date.now();
let confident = 0;
const results = [];

for (const group of groups) {
  const outcome = await findMatches(client, group, {
    threshold: config.metadata.matchThreshold,
    margin: config.metadata.matchMargin,
  });
  if (outcome.confident) confident += 1;
  results.push({ group, outcome });
  const best = outcome.best;
  const label = outcome.confident ? '自动' : '待确认';
  console.log(`[${label}] ${group.sourceFolder}${group.season ? ` (S${group.season})` : ''}`);
  if (best) {
    console.log(
      `    → id=${best.id} ${best.name_cn || best.name} | eps=${best.eps ?? '?'} | 分数=${best.score.toFixed(3)} | 次名差=${outcome.margin.toFixed(3)} | 命中查询="${best.bestQuery}"`
    );
    if (verbose) {
      for (const candidate of outcome.candidates.slice(0, 3)) {
        console.log(
          `         ${candidate.score.toFixed(3)}  id=${candidate.id} ${candidate.name_cn || candidate.name} (eps=${candidate.eps ?? '?'})`
        );
      }
    }
  } else {
    console.log('    → 没有候选');
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n合计 ${groups.length} 组，自动匹配 ${confident} 组，待确认 ${groups.length - confident} 组`);
console.log(`API 请求 ${client.requestCount} 次，耗时 ${seconds}s`);
db.close();
