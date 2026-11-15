import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../src/app/api/stream/route.js';

const upstreamUrl = 'https://93.184.216.34/live/master.m3u8';
const request = (url = upstreamUrl, options) => new Request(`https://app.example/api/stream?${new URLSearchParams({ url })}`, options);

test('HLS rewrites audio, init, keys, parts, alternate renditions and child playlists', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/index.m3u8"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="../key"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="iframe.m3u8"',
    '#EXT-X-PART:DURATION=0.5,URI="part.m4s"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"',
    '#EXT-X-RENDITION-REPORT:URI="alternate.m3u8"',
    'video/index.m3u8',
  ].join('\n'), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  try {
    const response = await GET(request());
    assert.equal(response.status, 200);
    const text = await response.text();
    const urls = [...text.matchAll(/(?:URI="|^)(\/api\/stream\?[^"\n]+)/gm)].map((match) => new URL(match[1], 'https://app.example').searchParams.get('url'));
    assert.equal(urls.length, 8);
    assert.ok(urls.includes('https://93.184.216.34/live/audio/index.m3u8'));
    assert.ok(urls.includes('https://93.184.216.34/key'));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally { globalThis.fetch = original; }
});

test('redirected DASH exposes final manifest base for relative segment resolution', async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => ++count === 1
    ? new Response(null, { status: 302, headers: { Location: '/redirected/manifest.mpd' } })
    : new Response('<MPD/>', { headers: { 'Content-Type': 'application/dash+xml' } });
  try {
    const response = await GET(request('https://93.184.216.34/manifest.mpd'));
    assert.equal(response.headers.get('X-Stream-URL'), 'https://93.184.216.34/redirected/manifest.mpd');
    assert.equal(await response.text(), '<MPD/>');
  } finally { globalThis.fetch = original; }
});

test('Range requests and 416 responses preserve seeking semantics', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_, options) => {
    assert.equal(options.headers.Range, 'bytes=100-200');
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */50' } });
  };
  try {
    const response = await GET(request('https://93.184.216.34/video.mp4', { headers: { Range: 'bytes=100-200' } }));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */50');
  } finally { globalThis.fetch = original; }
});

test('Oversized range requests like iOS Safari bytes=0-999999999 are clamped to safe serverless chunk size', async () => {
  const original = globalThis.fetch;
  let capturedRange = '';
  globalThis.fetch = async (_, options) => {
    capturedRange = options.headers.Range;
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-2/1000000000', 'Content-Type': 'video/mp4' },
    });
  };
  try {
    const response = await GET(request('https://93.184.216.34/video.mp4', { headers: { Range: 'bytes=0-999999999' } }));
    assert.equal(response.status, 206);
    assert.equal(capturedRange, `bytes=0-${2 * 1024 * 1024 - 1}`);
  } finally { globalThis.fetch = original; }
});

test('compressed media does not forward an incorrect compressed content length', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('decompressed content', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '5' } });
  try {
    const response = await GET(request('https://93.184.216.34/subtitle.vtt'));
    assert.equal(response.headers.get('Content-Length'), null);
    assert.equal(await response.text(), 'decompressed content');
  } finally { globalThis.fetch = original; }
});

test('offline, HTML error playlists, private targets and private redirects fail explicitly', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('Not found', { status: 404 });
    assert.equal((await GET(request())).status, 404);
    globalThis.fetch = async () => new Response('<html>Access denied</html>');
    assert.equal((await GET(request())).status, 502);
    assert.equal((await GET(request('http://127.0.0.1/private'))).status, 400);
    assert.equal((await GET(request('file:///etc/passwd'))).status, 400);
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    assert.equal((await GET(request())).status, 400);
  } finally { globalThis.fetch = original; }
});
