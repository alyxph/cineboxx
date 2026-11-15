import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHlsManager, getFfmpegPath } from '../src/lib/hls-transcode.js';
import { hlsFixture } from './helpers/hls-fixture.mjs';

test('real HEVC transcodes on demand, reuses cache, seeks far and cleans up', { timeout: 120000 }, async (t) => {
  const fixture = await hlsFixture();
  const manager = createHlsManager({ maxSessions: 1, idleMs: 60000, tempRoot: fixture.dir });
  t.after(async () => { await manager.close(); await fixture.close(); });
  const input = { sessionId: randomUUID(), targetUrl: fixture.url, height: 144,
    headers: { userAgent: 'CineBox-test', referer: 'https://example.com/', origin: 'https://example.com', cookie: 'test=1', authorization: 'Bearer test' } };
  const [session, duplicate] = await Promise.all([manager.start(input), manager.start(input)]);
  assert.equal(session, duplicate);
  assert.ok(Math.abs(session.duration - 180) < 0.1);
  const playlist = manager.playlist(session);
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(playlist, /#EXT-X-ENDLIST/);
  assert.equal((playlist.match(/#EXTINF/g) || []).length, 45);
  await assert.rejects(manager.start({ ...input, sessionId: randomUUID() }), { status: 503 });
  await assert.rejects(manager.start({ ...input, height: 360 }), { status: 409 });

  const first = await manager.segment(session.id, 'seg000000.ts');
  const worker = session.job;
  const plusTen = await manager.segment(session.id, 'seg000002.ts');
  assert.equal(session.job, worker, '+10s must use the current encode window');
  assert.ok(plusTen.length > 0);
  assert.deepEqual(await manager.segment(session.id, 'seg000000.ts'), first);
  const far = await manager.segment(session.id, 'seg000035.ts');
  assert.notEqual(session.job, worker);
  assert.equal(session.job.first, 35, 'far seek starts at the requested segment');
  assert.deepEqual(await manager.segment(session.id, 'seg000000.ts'), first, 'back seek uses server cache');

  const farFile = path.join(fixture.dir, 'far.ts');
  await writeFile(farFile, far);
  const { stderr } = await promisify(execFile)(getFfmpegPath(), ['-hide_banner', '-i', farFile, '-t', '0.2', '-f', 'null', '-'], { windowsHide: true });
  assert.match(stderr, /Video: h264/);
  assert.match(stderr, /Audio: aac/);
  assert.match(stderr, /start: 14[01]\./, 'far segment timestamps stay on the original movie timeline');
  assert.ok(fixture.requests.some((headers) => headers.origin === 'https://example.com' && headers.authorization === 'Bearer test'));
  await assert.rejects(manager.segment(session.id, '../secret'), { status: 400 });
  await assert.rejects(manager.segment(session.id, 'seg999999.ts'), { status: 404 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.segment(session.id, 'seg000020.ts', controller.signal), { name: 'AbortError' });

  const lastWorker = session.job;
  await manager.release(session.id);
  assert.ok(lastWorker.ended);
  assert.equal(existsSync(session.dir), false);
  await assert.rejects(manager.segment(session.id, 'seg000000.ts'), { status: 410 });
  await assert.rejects(manager.start(input), { status: 410 }, 'late playlist retries cannot revive a released session');

  const idle = await manager.start({ ...input, sessionId: randomUUID() });
  await manager.sweep(Date.now() + 60001);
  assert.equal(existsSync(idle.dir), false);

  const cancelledId = randomUUID();
  for (const height of [1080, 320, 120]) {
    const matching = await manager.start({ ...input, sessionId: randomUUID(), height });
    assert.equal(matching.height, height, 'selected resolution must not be silently capped to 720p or raised');
    await manager.release(matching.id);
  }
  const cancelledStart = manager.start({ ...input, sessionId: cancelledId });
  const rejection = assert.rejects(cancelledStart, { status: 410 });
  await manager.release(cancelledId);
  await rejection;

  const bounded = createHlsManager({ cacheBytes: 250000, tempRoot: fixture.dir });
  t.after(() => bounded.close());
  const cached = await bounded.start({ ...input, sessionId: randomUUID() });
  await bounded.segment(cached.id, 'seg000000.ts');
  const initialJob = cached.job;
  await initialJob.done;
  await initialJob.collecting;
  assert.ok(cached.bytes <= 250000, 'LRU pruning bounds the server cache');
  assert.equal(cached.cache.has(0), false, 'old segments are evicted when the cache fills');
  assert.ok((await bounded.segment(cached.id, 'seg000000.ts')).length > 0);
  assert.notEqual(cached.job, initialJob, 'evicted segments can be transcoded again');
  await bounded.close();
});

test('validation and failed ffmpeg startup release reserved capacity', async (t) => {
  const manager = createHlsManager({ ffmpegPath: path.resolve('missing-ffmpeg'), maxSessions: 1 });
  t.after(() => manager.close());
  const input = { sessionId: randomUUID(), targetUrl: 'https://example.com/video.mp4' };
  await assert.rejects(manager.start({ ...input, sessionId: '../bad' }), { status: 400 });
  await assert.rejects(manager.start({ ...input, targetUrl: 'file:///secret' }), { status: 400 });
  await assert.rejects(manager.start({ ...input, headers: { cookie: 'a\r\nInjected: x' } }), { status: 400 });
  await assert.rejects(manager.start(input), /ffmpeg/);
  await assert.rejects(manager.start({ ...input, sessionId: randomUUID() }), /ffmpeg/);
});
