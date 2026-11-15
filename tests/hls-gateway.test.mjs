import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsGateway, isHlsPlaybackAvailable } from '../src/lib/hls-gateway.js';
import { GET as playlist } from '../src/app/api/transcode/hls/route.js';
import { GET as segment } from '../src/app/api/transcode/segment/route.js';
import { POST, DELETE } from '../src/app/api/transcode/session/route.js';

function env(t) {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of ['NETLIFY', 'HLS_WORKER_URL', 'HLS_WORKER_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  return { set: (key, value) => { process.env[key] = value; }, delete: (key) => { delete process.env[key]; } };
}

test('serverless HLS forwards playlists, segments and lifecycle to the same authenticated worker', async (t) => {
  const vars = env(t);
  vars.set('NETLIFY', 'true');
  vars.set('HLS_WORKER_URL', 'https://worker.example');
  vars.set('HLS_WORKER_TOKEN', 'test-secret');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return options.method === 'GET'
      ? new Response(url.pathname.endsWith('/hls') ? '#EXTM3U\n/api/transcode/segment?sid=test&file=0.ts' : 'segment-bytes', { headers: { 'Content-Type': 'video/mp2t', 'Set-Cookie': 'private=secret' } })
      : new Response(null, { status: 204 });
  });
  assert.equal(isHlsPlaybackAvailable(), true);
  for (const [handler, path, method] of [[playlist, 'hls?session=test&height=320', 'GET'], [segment, 'segment?sid=test&file=0.ts', 'GET'], [POST, 'session?sid=test', 'POST'], [POST, 'session?sid=test&close=1', 'POST'], [DELETE, 'session?sid=test', 'DELETE']]) {
    const res = await handler(new Request(`https://app.example/api/transcode/${path}`, { method }));
    assert.equal(res.status, method === 'GET' ? 200 : 204);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('authorization'), null);
    assert.equal(calls.at(-1).url.href, `https://worker.example/api/transcode/${path}`);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer test-secret');
    assert.equal(calls.at(-1).options.redirect, 'error');
    await res.text();
  }
});

test('worker requires its secret on all session endpoints', async (t) => {
  const vars = env(t);
  vars.delete('HLS_WORKER_URL');
  vars.set('HLS_WORKER_TOKEN', 'test-secret');
  for (const handler of [playlist, segment, POST, DELETE]) {
    assert.equal((await handler(new Request('https://worker.example/api/transcode/session'))).status, 401);
  }
  assert.equal(await hlsGateway(new Request('https://worker.example/api/transcode/hls', { headers: { Authorization: 'Bearer test-secret' } })), null);
});

test('misconfiguration, loops and backend failure cannot leak credentials or pretend playback is ready', async (t) => {
  const vars = env(t);
  vars.set('NETLIFY', 'true');
  vars.set('HLS_WORKER_URL', 'https://worker.example');
  vars.delete('HLS_WORKER_TOKEN');
  const req = new Request('https://app.example/api/transcode/hls');
  assert.equal(isHlsPlaybackAvailable(), false);
  assert.equal((await hlsGateway(req)).status, 503);
  vars.set('HLS_WORKER_TOKEN', 'test-secret');
  assert.equal((await hlsGateway(new Request('https://worker.example/api/transcode/hls'))).status, 503);
  assert.equal((await hlsGateway(new Request(req, { headers: { 'x-cinebox-hls-hop': '1' } }))).status, 503);
  t.mock.method(globalThis, 'fetch', async () => new Response('test-secret internal details', { status: 403 }));
  const res = await hlsGateway(req);
  assert.equal(res.status, 503);
  assert.equal((await res.text()).includes('test-secret'), false);
});
