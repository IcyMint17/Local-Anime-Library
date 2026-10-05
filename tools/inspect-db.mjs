#!/usr/bin/env node
/** Dev tool: dump the local library database. */
import { openDatabase } from '../src/db/repo.js';
import { DB_PATH } from '../src/config.js';

const db = openDatabase(DB_PATH);

console.log('=== files.kind 分布 ===');
for (const row of db.prepare('SELECT kind, COUNT(*) AS count FROM files GROUP BY kind ORDER BY count DESC').all()) {
  console.log(`  ${row.kind}: ${row.count}`);
}

console.log('\n=== kind = movie 的文件 ===');
for (const row of db.prepare("SELECT name FROM files WHERE kind = 'movie'").all()) {
  console.log(`  ${row.name}`);
}

console.log('\n=== 每个 series 的文件构成 ===');
const series = db.prepare('SELECT id, source_folder, title_cn, match_state, media_kind FROM series ORDER BY source_folder').all();
for (const item of series) {
  const kinds = db
    .prepare('SELECT kind, COUNT(*) AS count FROM files WHERE series_id = ? GROUP BY kind')
    .all(item.id)
    .map((row) => `${row.kind}=${row.count}`)
    .join(' ');
  console.log(`  [${item.match_state}] ${item.source_folder} → ${item.title_cn} (${item.media_kind ?? '-'}) | ${kinds}`);
}

console.log('\n=== 未绑定的 series 的候选（前 5）===');
for (const item of series.filter((row) => row.match_state === 'unmatched')) {
  console.log(`  ${item.source_folder}`);
  const candidates = db
    .prepare('SELECT bangumi_id, score, payload FROM match_candidates WHERE series_id = ? ORDER BY score DESC LIMIT 5')
    .all(item.id);
  for (const candidate of candidates) {
    const payload = JSON.parse(candidate.payload);
    console.log(`     ${Number(candidate.score).toFixed(3)}  id=${candidate.bangumi_id} ${payload.name_cn || payload.name}`);
  }
}

console.log('\n=== 统计 ===');
console.log(`  series: ${db.prepare('SELECT COUNT(*) AS c FROM series').get().c}`);
console.log(`  files:  ${db.prepare('SELECT COUNT(*) AS c FROM files').get().c}`);
console.log(`  episodes: ${db.prepare('SELECT COUNT(*) AS c FROM episodes').get().c}`);
console.log(`  缓存条目: ${db.prepare('SELECT COUNT(*) AS c FROM meta_cache').get().c}`);

console.log('\n=== 剧集标题覆盖情况 ===');
const coverage = db
  .prepare(
    `SELECT s.title_cn, COUNT(e.id) AS total,
            SUM(CASE WHEN e.title_cn IS NOT NULL AND e.title_cn <> '' THEN 1 ELSE 0 END) AS with_cn,
            SUM(CASE WHEN e.title IS NOT NULL AND e.title <> '' THEN 1 ELSE 0 END) AS with_jp
       FROM episodes e JOIN series s ON s.id = e.series_id
      GROUP BY e.series_id ORDER BY s.title_cn`
  )
  .all();
let missing = 0;
for (const row of coverage) {
  if (row.with_cn < row.total) missing += 1;
  console.log(`  ${row.with_cn}/${row.total} 中文, ${row.with_jp}/${row.total} 原名  ${row.title_cn}`);
}
console.log(`  标题有缺失的番剧: ${missing} 部`);

console.log('\n=== 剧集标题示例（孤独摇滚！前 5 集）===');
const sample = db
  .prepare(
    `SELECT e.number, e.title, e.title_cn, e.air_date
       FROM episodes e JOIN series s ON s.id = e.series_id
      WHERE s.title_cn = '孤独摇滚！' ORDER BY e.sort LIMIT 5`
  )
  .all();
for (const row of sample) {
  console.log(`  ${row.number}. ${row.title_cn ?? '(无中文)'} / ${row.title ?? '(无原名)'} (${row.air_date ?? '?'})`);
}
db.close();
