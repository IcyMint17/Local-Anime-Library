#!/usr/bin/env node
/** Dev tool: compare the batched progress pass with the old per-series one. */
import { openDatabase, listSeries } from '../src/db/repo.js';
import { computeProgress, computeProgressAll } from '../src/library/progress.js';
import { DB_PATH } from '../src/config.js';

const db = openDatabase(DB_PATH);
const series = listSeries(db);

const countQueries = (fn) => {
  let prepared = 0;
  const real = db.prepare.bind(db);
  db.prepare = (sql) => {
    prepared += 1;
    return real(sql);
  };
  fn();
  db.prepare = real;
  return prepared;
};

const time = (label, fn, rounds = 200) => {
  fn();
  const started = process.hrtime.bigint();
  for (let i = 0; i < rounds; i += 1) fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / rounds;
  console.log(`  ${label}: ${ms.toFixed(3)} ms/次`);
  return ms;
};

console.log(`库中番剧: ${series.length} 部\n`);

const batchedQueries = countQueries(() => computeProgressAll(db, series));
const perSeriesQueries = countQueries(() => {
  for (const row of series) computeProgress(db, row);
});
console.log('SQL 语句数:');
console.log(`  批量: ${batchedQueries}`);
console.log(`  逐部: ${perSeriesQueries}`);

console.log('\n耗时:');
const batched = time('批量', () => computeProgressAll(db, series));
const perSeries = time('逐部', () => {
  for (const row of series) computeProgress(db, row);
});
console.log(`\n提速: ${(perSeries / batched).toFixed(1)}x`);

db.close();
