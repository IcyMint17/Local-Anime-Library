#!/usr/bin/env node
/**
 * Dev tool: show how local episode numbers line up with Bangumi episode numbers.
 * Usage: node tools/inspect-mapping.mjs [folderKeyword]
 */
import { openDatabase } from '../src/db/repo.js';
import { DB_PATH } from '../src/config.js';

const keyword = process.argv[2] ?? '';
const db = openDatabase(DB_PATH);

const series = db
  .prepare(
    `SELECT id, source_folder, title_cn, ep_offset, eps_total, bangumi_id
       FROM series
      WHERE source_folder LIKE ? OR title_cn LIKE ?
      ORDER BY source_folder`
  )
  .all(`%${keyword}%`, `%${keyword}%`);

for (const row of series) {
  const local = db
    .prepare("SELECT ep_number FROM files WHERE series_id = ? AND kind = 'episode' AND ep_number IS NOT NULL ORDER BY ep_number")
    .all(row.id)
    .map((r) => r.ep_number);
  const bangumi = db
    .prepare('SELECT number FROM episodes WHERE series_id = ? ORDER BY number')
    .all(row.id)
    .map((r) => r.number);
  const offset = row.ep_offset ?? 0;
  const mapped = local.map((n) => `${n}→${n + offset}`);
  const unmatched = local.filter((n) => !bangumi.includes(n + offset));

  console.log(`${row.source_folder}`);
  console.log(`  匹配: ${row.title_cn ?? '(未识别)'}  (bgm=${row.bangumi_id ?? '-'}, eps_total=${row.eps_total ?? '-'})`);
  console.log(`  偏移: ${offset}   本地 ${local.length} 集 / Bangumi ${bangumi.length} 集`);
  console.log(`  本地集号:   ${JSON.stringify(local)}`);
  console.log(`  Bangumi:    ${JSON.stringify(bangumi)}`);
  console.log(`  映射:       ${JSON.stringify(mapped)}`);
  console.log(`  对不上的:   ${unmatched.length ? JSON.stringify(unmatched) : '（无）'}`);

  // Side-by-side sample: does the local file actually look like that episode?
  const samples = db
    .prepare(
      `SELECT f.ep_label, f.name AS file_name, e.title_cn, e.title, e.number AS bangumi_number
         FROM files f
         LEFT JOIN episodes e ON e.series_id = f.series_id AND e.number = f.ep_number + ?
        WHERE f.series_id = ? AND f.kind = 'episode' AND f.missing = 0
        ORDER BY f.ep_number LIMIT 4`
    )
    .all(offset, row.id);
  for (const sample of samples) {
    console.log(
      `    ep ${String(sample.ep_label).padStart(5)} → BGM ${sample.bangumi_number ?? '-'}  ${sample.title_cn ?? '(无标题)'}`
    );
  }

  const kinds = db
    .prepare("SELECT kind, COUNT(*) AS count FROM files WHERE series_id = ? AND missing = 0 GROUP BY kind")
    .all(row.id);
  console.log(`  文件分类: ${kinds.map((k) => `${k.kind}=${k.count}`).join('  ')}`);
  const types = db
    .prepare('SELECT type, COUNT(*) AS count FROM episodes WHERE series_id = ? GROUP BY type')
    .all(row.id);
  console.log(`  Bangumi 类型: ${types.map((t) => `type=${t.type}(${t.count})`).join('  ')}`);
  console.log('');
}

db.close();
