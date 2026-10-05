import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../src/config.js';
import { openDatabase } from '../src/db/repo.js';
import { createRoutes } from '../src/api/routes.js';
import { createServer } from '../src/server.js';

/** A scan controller with the same subscribe() surface as the real one. */
function fakeScanController() {
  const listeners = new Set();
  let status = { running: false, progress: { phase: 'idle' }, last: null };
  const broadcast = () => {
    for (const listener of listeners) listener(status);
  };
  return {
    isRunning: () => status.running,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
    async start() {
      status = { running: true, progress: { phase: 'match', index: 1, total: 3 }, last: null };
      // The real controller broadcasts from inside its async scan loop, i.e.
      // while the client is idle-waiting on the stream. Mirror that ordering.
      await new Promise((resolve) => setTimeout(resolve, 20));
      broadcast();
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = {
        running: false,
        progress: { phase: 'done' },
        last: { groups: 3, matched: 3, unmatched: 0, finishedAt: '2026-01-01T00:00:00.000Z' },
      };
      broadcast();
    },
  };
}

async function startHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-sse-'));
  const db = openDatabase(path.join(dir, 'library.db'));
  const scanController = fakeScanController();
  const config = { ...structuredClone(DEFAULT_CONFIG), coversDir: path.join(dir, 'covers'), dataDir: dir };
  const { routes } = createRoutes({ db, client: {}, config, saveConfig: () => config, scanController });
  const server = createServer({
    routes,
    publicDir: path.join(dir, 'public'),
    coversDir: path.join(dir, 'covers'),
    scanController,
    logger: { error() {}, warn() {}, log() {} },
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    scanController,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

/** Reads SSE frames for a bounded time so the test can never hang. */
function createReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  // A read that timed out is still pending — keep it and reuse it, otherwise the
  // next collect() starts a second read and silently swallows the data.
  let pending = null;

  const drain = () => {
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5).trim()));
      }
    }
  };

  return {
    events,
    async collect(ms) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (!pending) pending = reader.read();
        const remaining = deadline - Date.now();
        const chunk = await Promise.race([
          pending,
          new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
        ]);
        if (chunk.timedOut) break;
        pending = null;
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        drain();
      }
      return events;
    },
  };
}

test('GET /api/scan/stream sends the current state, then pushes progress and completion', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const controller = new AbortController();
  t.after(() => controller.abort());

  const response = await fetch(`${harness.base}/api/scan/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const reader = createReader(response);
  const initial = await reader.collect(400);
  assert.equal(initial.length, 1, 'the client is told the current state immediately');
  assert.equal(initial[0].running, false);
  assert.equal(initial[0].progress.phase, 'idle');

  await fetch(`${harness.base}/api/scan`, { method: 'POST' });
  const during = await reader.collect(1500);

  const runningEvents = during.filter((event) => event.running);
  assert.ok(runningEvents.length >= 1, 'a running event was pushed');
  assert.equal(runningEvents[0].progress.phase, 'match');
  assert.equal(runningEvents[0].progress.index, 1);

  const finished = during.filter((event) => !event.running && event.last);
  assert.ok(finished.length >= 1, 'a completion event was pushed');
  assert.equal(finished[0].last.groups, 3);
});

test('the stream unsubscribes when the client disconnects', async (t) => {
  const harness = await startHarness();
  t.after(() => harness.close());

  const controller = new AbortController();
  const response = await fetch(`${harness.base}/api/scan/stream`, { signal: controller.signal });
  const reader = createReader(response);
  await reader.collect(250);
  assert.equal(harness.scanController.listenerCount(), 1, 'connected');

  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(harness.scanController.listenerCount(), 0, 'a closed connection must not leak');
});
