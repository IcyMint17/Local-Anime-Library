import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../src/config.js';
import { openDatabase, insertSeries, upsertFile, setWatchMark, replaceEpisodes } from '../src/db/repo.js';
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
  const revealed = [];
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
    revealFolder: (folder) => {
      revealed.push(folder);
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
    revealed,
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
function fakeClient({ subject, episodes, characters = [], persons = [], comments = [] }) {
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
    async getSubjectCharacters() {
      return characters;
    },
    async getSubjectPersons() {
      return persons;
    },
    async getSubjectComments() {
      return comments;
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

test('preferences: theme, dock, glass and sidebar survive a port change', async () => {
  const harness = await startHarness();

  const initial = await (await fetch(`${harness.base}/api/preferences`)).json();
  assert.equal(initial.mode, 'dark');
  assert.equal(initial.sidebarCollapsed, false);
  assert.equal(initial.theme, null);
  assert.equal(initial.dock, 'bottom');
  assert.equal(initial.glass, 26);

  const saved = await (
    await fetch(`${harness.base}/api/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme: { id: 'sakura', label: '樱粉', accent: '#ff6fa5', accent2: '#ff9a6c' },
        mode: 'light',
        dock: 'left',
        glass: 18,
        sidebarCollapsed: true,
      }),
    })
  ).json();
  assert.equal(saved.ok, true);

  const stored = await (await fetch(`${harness.base}/api/preferences`)).json();
  assert.deepEqual(stored.theme, { id: 'sakura', label: '樱粉', accent: '#ff6fa5', accent2: '#ff9a6c' });
  assert.equal(stored.mode, 'light');
  assert.equal(stored.dock, 'left');
  assert.equal(stored.glass, 18);
  assert.equal(stored.sidebarCollapsed, true);

  // A partial update must leave the other preferences alone.
  await fetch(`${harness.base}/api/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'dark', glass: 99, dock: 'diagonal' }),
  });
  const after = await (await fetch(`${harness.base}/api/preferences`)).json();
  assert.equal(after.mode, 'dark');
  assert.equal(after.theme.accent, '#ff6fa5');
  assert.equal(after.sidebarCollapsed, true);
  assert.equal(after.dock, 'left', 'an unknown edge is ignored');
  assert.equal(after.glass, 48, 'glass is clamped to the slider range');

  const rejected = await fetch(`${harness.base}/api/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: { accent: 'not-a-colour' } }),
  });
  assert.equal(rejected.status, 400);

  await harness.close();
});

test('favourites: starring a series persists without touching its updated_at', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|fav|1',
    source_folder: '收藏测试',
    title_cn: '收藏测试',
    media_kind: 'episode',
    match_state: 'manual',
  });
  const before = harness.db.prepare('SELECT updated_at FROM series WHERE id = ?').get(seriesId).updated_at;

  const starred = await (
    await fetch(`${harness.base}/api/series/${seriesId}/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: true }),
    })
  ).json();
  assert.equal(starred.ok, true);
  assert.equal(starred.favorite, true);

  const library = await (await fetch(`${harness.base}/api/library`)).json();
  assert.equal(library.items.find((item) => item.id === seriesId).favorite, true);

  const detail = await (await fetch(`${harness.base}/api/series/${seriesId}`)).json();
  assert.equal(detail.series.favorite, true);

  const after = harness.db.prepare('SELECT updated_at, favorite FROM series WHERE id = ?').get(seriesId);
  assert.equal(after.favorite, 1);
  assert.equal(after.updated_at, before, 'a bookmark must not reorder "最近扫描"');

  const unstarred = await (
    await fetch(`${harness.base}/api/series/${seriesId}/favorite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: false }),
    })
  ).json();
  assert.equal(unstarred.favorite, false);

  const unknown = await fetch(`${harness.base}/api/series/999999/favorite`, { method: 'POST' });
  assert.equal(unknown.status, 404);

  await harness.close();
});

test('timeline: watch ticks carry the episode title, download state and air dates', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|timeline|1',
    source_folder: '时间线测试',
    title_cn: '时间线测试',
    media_kind: 'episode',
    match_state: 'manual',
  });
  replaceEpisodes(harness.db, seriesId, [
    { bangumi_id: 1, number: 1, sort: 1, ep: 1, type: 0, title: 'First', title_cn: '第一话' },
    {
      bangumi_id: 1,
      number: 2,
      sort: 2,
      ep: 2,
      type: 0,
      title: 'Second',
      title_cn: '第二话',
      air_date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    },
  ]);
  const media = path.join(harness.dir, 'timeline-01.mkv');
  fs.writeFileSync(media, 'x');
  upsertFile(harness.db, seriesId, {
    path: media,
    name: path.basename(media),
    kind: 'episode',
    ep_number: 1,
  });
  setWatchMark(harness.db, seriesId, 'ep:1', true);

  const timeline = await (await fetch(`${harness.base}/api/timeline`)).json();
  const event = timeline.events.find((entry) => entry.seriesId === seriesId);
  assert.ok(event, 'the watch tick must appear on the timeline');
  assert.equal(event.label, '第 1 集');
  assert.equal(event.episodeTitle, '第一话');
  assert.equal(event.downloaded, true);
  assert.equal(event.title, '时间线测试');

  const upcoming = timeline.upcoming.find((entry) => entry.seriesId === seriesId);
  assert.ok(upcoming, 'the future episode must be listed');
  assert.equal(upcoming.number, 2);
  assert.ok(timeline.additions.some((entry) => entry.id === seriesId));

  await harness.close();
});


test('folders: POST /api/series/:id/reveal opens the folder that holds the files', async () => {
  const harness = await startHarness();
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|reveal|1',
    source_folder: 'Reveal Me',
    title_cn: 'Reveal Me',
    media_kind: 'episode',
    match_state: 'manual',
  });
  const folder = path.join(harness.dir, 'Reveal Me');
  fs.mkdirSync(folder, { recursive: true });
  const media = path.join(folder, 'episode 01.mkv');
  fs.writeFileSync(media, 'x');
  upsertFile(harness.db, seriesId, { path: media, name: 'episode 01.mkv', kind: 'episode', ep_number: 1 });

  const response = await fetch(`${harness.base}/api/series/${seriesId}/reveal`, { method: 'POST' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.folder, folder);
  assert.deepEqual(harness.revealed, [folder]);

  const unknown = await fetch(`${harness.base}/api/series/999999/reveal`, { method: 'POST' });
  assert.equal(unknown.status, 404);

  await harness.close();
});


test('detail extras: rating distribution, characters, staff and comments are exposed', async () => {
  const subject = {
    id: 42,
    name: 'Test Show',
    name_cn: '测试番剧',
    date: '2025-10-04',
    eps: 12,
    rating: { score: 7.6, rank: 1234, total: 5600, count: { 1: 1, 7: 900, 8: 3000, 10: 5 } },
    collection: { wish: 100, collect: 2000, doing: 300, on_hold: 10, dropped: 4 },
    tags: [{ name: 'TV', count: 99 }, { name: '科幻', count: 40 }],
    infobox: [
      { key: '别名', value: 'Test Alias' },
      { key: '动画制作', value: 'Test Studio' },
      { key: '导演', value: 'Test Director' },
    ],
  };
  const harness = await startHarness({
    client: fakeClient({
      subject,
      episodes: [],
      characters: [
        {
          id: 1,
          name: '角色 A',
          relation: '主角',
          images: { small: 'https://example.test/a.jpg' },
          actors: [{ name: '声优 A', images: { small: 'https://example.test/va.jpg' } }],
        },
      ],
      persons: [{ id: 9, name: 'Passione', relation: '动画制作', images: {} }],
      comments: [{ id: 3, user: { nickname: '用户 A' }, score: 8, comment: '很好看' }],
    }),
  });
  const seriesId = insertSeries(harness.db, {
    local_key: 'a|extras|1',
    source_folder: 'Extras',
    title_cn: '测试番剧',
    bangumi_id: 42,
    media_kind: 'episode',
    match_state: 'manual',
  });

  const response = await fetch(`${harness.base}/api/series/${seriesId}/extras`);
  const body = await response.json();
  assert.equal(body.available, true);
  assert.equal(body.rating.score, 7.6);
  assert.equal(body.rating.distribution.length, 10);
  assert.equal(body.rating.distribution.find((row) => row.score === 8).count, 3000);
  assert.equal(body.collection.collect, 2000);
  assert.deepEqual(body.tags[0], { name: 'TV', count: 99 });
  assert.deepEqual(body.info.aliases, ['Test Alias']);
  assert.equal(body.characters[0].name, '角色 A');
  assert.equal(body.characters[0].actors[0].name, '声优 A');
  assert.equal(body.characters[0].image, 'https://example.test/a.jpg');
  assert.equal(body.staff[0].relation, '动画制作');
  assert.equal(body.staff[0].name, 'Test Studio');
  assert.equal(body.staff[1].relation, '导演');

  // Unmatched series simply has no Bangumi extras.
  const unmatchedId = insertSeries(harness.db, {
    local_key: 'a|extras|2',
    source_folder: 'Unmatched',
    title_cn: '未匹配',
  });
  const unmatched = await (await fetch(`${harness.base}/api/series/${unmatchedId}/extras`)).json();
  assert.equal(unmatched.available, false);
  assert.equal(unmatched.reason, 'unmatched');

  await harness.close();
});
