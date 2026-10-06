import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../src/config.js';
import { openDatabase, insertSeries, upsertFile, setWatchMark } from '../src/db/repo.js';
import { createRoutes } from '../src/api/routes.js';
import { createServer } from '../src/server.js';

// Every harness is tracked so a failing assertion can never leave an HTTP
// server listening — that would keep the whole test run from exiting.
const openHarnesses = [];
test.after(async () => {
  await Promise.all(openHarnesses.map((harness) => harness.close()));
});

/** Boots the real HTTP server against a throwaway database. */
async function startHarness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-routes-'));
  const db = openDatabase(path.join(dir, 'library.db'));
  const opened = [];
  const config = { ...structuredClone(DEFAULT_CONFIG), coversDir: path.join(dir, 'covers') };

  const { routes } = createRoutes({
    db,
    client: options.client ?? {},
    config,
    saveConfig: () => config,
    scanController: { isRunning: () => false, start: async () => {} },
    // Injected so tests never launch the user's media player.
    openFile: (filePath) => {
      opened.push(filePath);
      return true;
    },
  });

  const server = createServer({
    routes,
    publicDir: path.join(dir, 'public'),
    coversDir: path.join(dir, 'covers'),
    logger: { error() {}, warn() {}, log() {} },
  });
  // Keep-alive connections (the SSE stream in particular) would otherwise make
  // server.close() wait forever.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  const harness = {
    dir,
    db,
    opened,
    base,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
  openHarnesses.push(harness);
  return harness;
}

/** Minimal stand-in for BangumiClient so match tests stay offline. */
function fakeClient({ subject, episodes }) {
  return {
    proxy: null,
    userAgent: 'test',
    logger: { warn() {} },
    async getSubject() {
      return subject;
    },
    async getEpisodes() {
      return episodes;
    },
  };
}

test('playlist: POST /api/files/:id/play hands the file to the opener', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, { local_key: 'a|b|x', source_folder: 'b' });
  const media = path.join(harness.dir, 'episode 01 [1080p].mkv');
  fs.writeFileSync(media, 'not really a video');
  const fileId = upsertFile(harness.db, seriesId, {
    path: media,
    name: path.basename(media),
    ext: '.mkv',
    size: 20,
    kind: 'episode',
    ep_number: 1,
  });

  const response = await fetch(`${harness.base}/api/files/${fileId}/play`, { method: 'POST' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.path, media);
  assert.deepEqual(harness.opened, [media], 'the opener must receive the full path');

  await harness.close();
});

test('playlist: unknown id is 404 and a vanished file is 410 (opener never runs)', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, { local_key: 'a|c|x', source_folder: 'c' });
  const media = path.join(harness.dir, 'gone.mkv');
  fs.writeFileSync(media, 'x');
  const fileId = upsertFile(harness.db, seriesId, { path: media, name: 'gone.mkv', kind: 'episode', ep_number: 1 });

  const unknown = await fetch(`${harness.base}/api/files/999999/play`, { method: 'POST' });
  assert.equal(unknown.status, 404);

  fs.unlinkSync(media);
  const vanished = await fetch(`${harness.base}/api/files/${fileId}/play`, { method: 'POST' });
  assert.equal(vanished.status, 410);
  assert.deepEqual(harness.opened, [], 'a missing file must never reach the player');

  await harness.close();
});

test('library endpoints: listing, detail and watch toggling', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|d|x',
    source_folder: 'd',
    title_cn: '测试番剧',
    eps_total: 3,
    media_kind: 'episode',
    match_state: 'auto',
  });
  for (const number of [1, 2, 3]) {
    upsertFile(harness.db, seriesId, {
      path: path.join(harness.dir, `[0${number}].mkv`),
      name: `[0${number}].mkv`,
      kind: 'episode',
      ep_number: number,
      ep_label: `0${number}`,
    });
  }
  upsertFile(harness.db, seriesId, {
    path: path.join(harness.dir, '[NCED].mkv'),
    name: '[NCED].mkv',
    kind: 'special',
  });

  const library = await (await fetch(`${harness.base}/api/library`)).json();
  assert.equal(library.items.length, 1);
  assert.equal(library.stats.total, 1);
  assert.equal(library.items[0].progress.status, 'none');
  assert.equal(library.items[0].progress.localTotal, 3);
  assert.equal(library.items[0].progress.specials, 1);
  assert.equal(library.items[0].coverUrl, null);

  const detail = await (await fetch(`${harness.base}/api/series/${seriesId}`)).json();
  assert.equal(detail.episodes.length, 3);
  assert.equal(detail.extras.length, 1);
  assert.equal(detail.counts.files, 4);
  assert.ok(detail.episodes[0].itemKey.startsWith('ep:'));

  const watched = await (
    await fetch(`${harness.base}/api/series/${seriesId}/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey: 'ep:1', watched: true }),
    })
  ).json();
  assert.equal(watched.progress.status, 'watching');
  assert.equal(watched.progress.watched, 1);

  const watchedAll = await (
    await fetch(`${harness.base}/api/series/${seriesId}/watch-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watched: true }),
    })
  ).json();
  assert.equal(watchedAll.progress.status, 'completed', 'specials must not block completion');
  assert.equal(watchedAll.progress.percent, 1);

  const cleared = await (
    await fetch(`${harness.base}/api/series/${seriesId}/watch-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watched: false }),
    })
  ).json();
  assert.equal(cleared.progress.status, 'none');

  await harness.close();
});

test('library endpoints: a missing episode number cannot be toggled into the count', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|e|x',
    source_folder: 'e',
    eps_total: 12,
    media_kind: 'episode',
  });
  upsertFile(harness.db, seriesId, {
    path: path.join(harness.dir, '[01].mkv'),
    name: '[01].mkv',
    kind: 'episode',
    ep_number: 1,
  });
  setWatchMark(harness.db, seriesId, 'ep:9', true);

  const detail = await (await fetch(`${harness.base}/api/series/${seriesId}`)).json();
  assert.equal(detail.progress.watched, 0, 'marks for episodes we do not own are ignored');
  assert.equal(detail.progress.status, 'none');

  await harness.close();
});

test('library endpoints: bad input is rejected instead of silently accepted', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, { local_key: 'a|f|x', source_folder: 'f' });

  const noKey = await fetch(`${harness.base}/api/series/${seriesId}/watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ watched: true }),
  });
  assert.equal(noKey.status, 400);

  const noSeries = await fetch(`${harness.base}/api/series/424242/watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey: 'ep:1', watched: true }),
  });
  assert.equal(noSeries.status, 404);

  const unknownRoute = await fetch(`${harness.base}/api/nope`);
  assert.equal(unknownRoute.status, 404);

  await harness.close();
});

test('episode mapping: manual override is stored and reflected in the detail view', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|g|x',
    source_folder: 'g',
    eps_total: 11,
    media_kind: 'episode',
  });
  for (const number of [67, 68, 69]) {
    upsertFile(harness.db, seriesId, {
      path: path.join(harness.dir, `${number}.mkv`),
      name: `${number}.mkv`,
      kind: 'episode',
      ep_number: number,
      ep_label: String(number),
    });
  }

  const saved = await (
    await fetch(`${harness.base}/api/series/${seriesId}/offset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'manual', localNumber: 67, bangumiNumber: 1 }),
    })
  ).json();
  assert.equal(saved.mapping.offset, -66);
  assert.equal(saved.mapping.auto, false);

  // A manual mapping must survive a rescan-driven auto recompute request…
  const detail = await (await fetch(`${harness.base}/api/series/${seriesId}`)).json();
  assert.equal(detail.mapping.offset, -66);
  assert.equal(detail.mapping.auto, false);
  assert.deepEqual(detail.episodes.map((e) => e.number), [67, 68, 69]);

  const outOfRange = await fetch(`${harness.base}/api/series/${seriesId}/offset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'manual', localNumber: 1, bangumiNumber: 999999 }),
  });
  assert.equal(outOfRange.status, 400);

  await harness.close();
});

test('episode mapping: auto mode picks up absolute numbering after matching', async () => {
  const localNumbers = [67, 68, 69, 70];
  const bangumiEpisodes = [1, 2, 3, 4, 5].map((number) => ({
    number,
    sort: number,
    title: `episode ${number}`,
    title_cn: `第${number}集`,
    air_date: '2026-04-08',
  }));
  const harness = await startHarness({
    client: fakeClient({
      subject: {
        id: 547888,
        name: 'Re:ゼロから始める異世界生活 4th season 喪失編',
        name_cn: 'Re：从零开始的异世界生活 第四季 丧失篇',
        date: '2026-04-08',
        eps: 11,
        summary: '简介',
        images: { large: null },
        rating: { score: 7.7, total: 100 },
      },
      episodes: bangumiEpisodes,
    }),
  });
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|h|x',
    source_folder: 'h',
    media_kind: 'episode',
    match_state: 'unmatched',
  });
  for (const number of localNumbers) {
    upsertFile(harness.db, seriesId, {
      path: path.join(harness.dir, `${number}.mkv`),
      name: `${number}.mkv`,
      kind: 'episode',
      ep_number: number,
      ep_label: String(number),
    });
  }

  const bound = await (
    await fetch(`${harness.base}/api/series/${seriesId}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bangumiId: 547888 }),
    })
  ).json();

  assert.equal(bound.ok, true);
  assert.equal(bound.mapping.offset, -66, 'local 67 must line up with Bangumi episode 1');
  assert.equal(bound.mapping.auto, true);
  assert.equal(bound.mapping.matched, 4);

  const detail = await (await fetch(`${harness.base}/api/series/${seriesId}`)).json();
  assert.deepEqual(
    detail.episodes.map((e) => [e.number, e.bangumiNumber]),
    [
      [67, 1],
      [68, 2],
      [69, 3],
      [70, 4],
    ]
  );
  assert.equal(detail.missing.length, 1, 'Bangumi episode 5 is genuinely not on disk');

  await harness.close();
});

test('episode mapping: a folder numbered from 0 lines up with episode 1', async () => {
  const harness = await startHarness({
    client: fakeClient({
      subject: { id: 373247, name: '無職転生Ⅱ', name_cn: '无职转生 第二季', eps: 3, images: {}, rating: {} },
      episodes: [1, 2, 3].map((number) => ({ number, sort: number, title: `t${number}`, title_cn: `第${number}集` })),
    }),
  });
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|i|x',
    source_folder: 'i',
    media_kind: 'episode',
    match_state: 'unmatched',
  });
  for (const number of [0, 1, 2]) {
    upsertFile(harness.db, seriesId, {
      path: path.join(harness.dir, `0${number}.mkv`),
      name: `0${number}.mkv`,
      kind: 'episode',
      ep_number: number,
      ep_label: `0${number}`,
    });
  }

  const bound = await (
    await fetch(`${harness.base}/api/series/${seriesId}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bangumiId: 373247 }),
    })
  ).json();

  assert.equal(bound.mapping.offset, 1, 'the 00 file is episode 1');
  const detail = await (await fetch(`${harness.base}/api/series/${seriesId}`)).json();
  assert.deepEqual(
    detail.episodes.map((e) => [e.number, e.bangumiNumber]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ]
  );

  await harness.close();
});

test('library endpoints: a file without an episode number is still listed, never silently dropped', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|movie|x',
    source_folder: '小林家的龙女仆 怕寂寞的龙',
    title_cn: '小林家的龙女仆 怕寂寞的龙',
    media_kind: 'episode',
    bangumi_id: 514353,
    match_state: 'manual',
  });
  // Exactly what the scanner stores when it cannot find an episode number: the
  // parser's "episode" default with a null number.
  const fileId = upsertFile(harness.db, seriesId, {
    path: path.join(harness.dir, 'movie.mkv'),
    name: "[Feibanyama] Miss Kobayashi's Dragon Maid- A lonely dragon wants to be loved.mkv",
    kind: 'episode',
    ep_number: null,
  });

  const detail = await (await fetch(`${harness.base}/api/series/${seriesId}`)).json();
  assert.equal(detail.episodes.length, 0);
  assert.equal(detail.extras.length, 1, 'the only file must not disappear from the detail view');
  assert.equal(detail.extras[0].id, fileId);
  assert.equal(detail.extras[0].kind, 'special');
  assert.deepEqual(detail.extras[0].files.map((file) => file.id), [fileId]);
  assert.equal(detail.counts.files, 1);

  await harness.close();
});

test('preferences: theme, mode and sidebar survive a port change', async () => {
  const harness = await startHarness();

  const initial = await (await fetch(`${harness.base}/api/preferences`)).json();
  assert.equal(initial.mode, 'dark');
  assert.equal(initial.sidebarCollapsed, false);
  assert.equal(initial.theme, null);

  const saved = await (
    await fetch(`${harness.base}/api/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme: { id: 'sakura', label: '樱粉', accent: '#ff6fa5', accent2: '#ff9a6c' },
        mode: 'light',
        sidebarCollapsed: true,
      }),
    })
  ).json();
  assert.equal(saved.ok, true);

  const stored = await (await fetch(`${harness.base}/api/preferences`)).json();
  assert.deepEqual(stored.theme, { id: 'sakura', label: '樱粉', accent: '#ff6fa5', accent2: '#ff9a6c' });
  assert.equal(stored.mode, 'light');
  assert.equal(stored.sidebarCollapsed, true);

  // A partial update must leave the other preferences alone.
  await fetch(`${harness.base}/api/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'dark' }),
  });
  const after = await (await fetch(`${harness.base}/api/preferences`)).json();
  assert.equal(after.mode, 'dark');
  assert.equal(after.theme.accent, '#ff6fa5');
  assert.equal(after.sidebarCollapsed, true);

  const rejected = await fetch(`${harness.base}/api/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: { accent: 'not-a-colour' } }),
  });
  assert.equal(rejected.status, 400);

  await harness.close();
});
