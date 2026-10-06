import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../src/config.js';
import { openDatabase, listSeries, listFiles, listEpisodes } from '../src/db/repo.js';
import { runScan } from '../src/scan/pipeline.js';

/**
 * A movie folder whose name carries the Chinese title, whose release file only
 * carries the English one, and whose file has no episode number at all — the
 * shape that used to produce an entry with zero episodes and no visible file.
 */
const FOLDER = '小林家的龙女仆 怕寂寞的龙';
const FILE = "[Feibanyama] Miss Kobayashi's Dragon Maid- A lonely dragon wants to be loved [BILIBILI WebRip 2160p HEVC OPUS Multi-Subs].mkv";
const SUBJECT = {
  id: 514353,
  name: '小林さんちのメイドラゴン さみしがりやの竜',
  name_cn: '小林家的龙女仆 怕寂寞的龙',
  summary: '剧场版',
  date: '2025-06-27',
  eps: 1,
  rating: { score: 7.2, total: 100 },
  images: {}, // no artwork keeps ensureCover offline
};

/** Minimal BangumiClient stand-in: one subject, one episode, no network. */
function fakeClient() {
  return {
    proxy: null,
    userAgent: 'test',
    requestCount: 0,
    logger: { warn() {} },
    async searchSubjects(keyword) {
      return /怕寂寞|Kobayashi/i.test(keyword) ? [SUBJECT] : [];
    },
    async getSubject() {
      return SUBJECT;
    },
    async getEpisodes() {
      return [{ sort: 1, ep: 1, type: 0, name: 'A lonely dragon wants to be loved', name_cn: '', airdate: '2025-06-27' }];
    },
  };
}

test('scan: a lone unnumbered file becomes a matched movie with a visible file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-pipeline-'));
  const library = path.join(dir, 'library');
  fs.mkdirSync(path.join(library, FOLDER), { recursive: true });
  fs.writeFileSync(path.join(library, FOLDER, FILE), 'not really a video');

  const db = openDatabase(path.join(dir, 'library.db'));
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    scan: { ...structuredClone(DEFAULT_CONFIG.scan), dirs: [library] },
  };

  const summary = await runScan({
    db,
    config,
    client: fakeClient(),
    coversDir: path.join(dir, 'covers'),
  });

  assert.equal(summary.groups, 1);
  assert.equal(summary.matched, 1, 'the movie must be recognised without a manual step');
  assert.equal(summary.unmatched, 0);

  const [series] = listSeries(db);
  assert.equal(series.bangumi_id, 514353);
  assert.equal(series.media_kind, 'movie');
  assert.equal(series.match_state, 'auto');
  assert.equal(series.eps_total, 1);

  const files = listFiles(db, series.id);
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, 'movie', 'the lone file has to be classified as the movie itself');
  assert.equal(files[0].ep_number, null);

  assert.equal(listEpisodes(db, series.id).length, 1, "Bangumi's single episode should be stored");

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
