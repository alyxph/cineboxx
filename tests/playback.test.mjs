import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSources, streamKind, isLiveVideo, nextAvailableChannel, proxyUrl } from '../src/lib/playback.js';
import { fetchJson } from '../src/lib/http.js';
import { parseSubtitleText, subtitleTextAt } from '../src/lib/subtitles.js';

test('malformed source entries do not crash or permit non-media protocols', () => {
  const result = normalizeSources({ streams: [null, {}, 'javascript:alert(1)', { url: 42 }, { url: 'https://cdn.example/video.mp4' }], subtitles: [null, { url: 'https://cdn.example/id.vtt' }] });
  assert.equal(result.streams.length, 1);
  assert.equal(result.subtitles[0].name, 'Bahasa');
});

test('empty source lists do not hide a valid direct URL or another source list', () => {
  const result = normalizeSources({ streams: [], sources: [{ url: 'https://cdn.example/first.mp4' }], url: 'https://cdn.example/backup.mp4' });
  assert.equal(result.streams.length, 2);
});

test('separate video and audio tracks use file playback, while manifests use DASH', () => {
  const result = normalizeSources({ streams: [{ video: ['https://cdn.example/video.mp4'], audio: [{ baseUrl: 'https://cdn.example/audio.m4a' }], format: 'dash' }] });
  assert.equal(streamKind(result.streams[0]), 'file');
  assert.equal(streamKind({ url: 'https://player.example/live.MPD?token=x' }), 'dash');
  assert.equal(streamKind({ url: 'https://player.example/live.m3u8' }), 'hls');
  assert.equal(streamKind({ url: 'https://cdn.example/embed/id' }), 'iframe');
});

test('normalization retains inherited headers and DRM and deduplicates identical streams', () => {
  const stream = { url: 'https://cdn.example/live.mpd', headers: { Cookie: 'test' } };
  const result = normalizeSources({ headers: { Referer: 'https://example.com/' }, drm: { type: 'clearkey' }, streams: [stream, stream] });
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].headers.Referer, 'https://example.com/');
  assert.equal(result.streams[0].isDrm, true);
  const proxied = new URL(proxyUrl(stream.url, { origin: 'https://example.com', authorization: 'test' }), 'https://local.example');
  assert.equal(proxied.searchParams.get('authorization'), 'test');
});

test('HLS transcode uses one explicit session and ignores the upstream MP4 extension', () => {
  const stream = { url: 'https://cdn.example/hevc.mp4', format: 'hls', headers: {
    'x-transcode': 'h264', 'x-transcode-format': 'hls', 'x-transcode-height': '720', Origin: 'https://example.com',
  } };
  assert.equal(streamKind(stream), 'hls');
  const url = proxyUrl(stream.url, stream.headers, 'player-session-12345678');
  assert.equal(proxyUrl(stream.url, { ...stream.headers, ss: '100' }, 'player-session-12345678'), url);
  const parsed = new URL(url, 'https://local.example');
  assert.equal(parsed.pathname, '/api/transcode/hls');
  assert.equal(parsed.searchParams.get('session'), 'player-session-12345678');
  assert.equal(parsed.searchParams.get('origin'), 'https://example.com');
});

test('TV selection wraps, skips failed channels and stops after every candidate failed', () => {
  const channels = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextAvailableChannel(channels, 'c', new Set(['a', 'c'])).id, 'b');
  assert.equal(nextAvailableChannel(channels, 'a', new Set(['a', 'b', 'c'])), null);
  assert.equal(nextAvailableChannel([], 'a', new Set()), null);
  assert.equal(nextAvailableChannel(channels, 'missing', new Set()).id, 'a');
  assert.equal(isLiveVideo({ type: 'live_tv' }), true);
  assert.equal(isLiveVideo({ modelId: 'CineTv' }), true);
});

test('API deadline covers response body and cleans up cancelled requests', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) });
  try { await assert.rejects(fetchJson('https://example.com', { timeoutMs: 20 }), /tidak merespons/); }
  finally { globalThis.fetch = original; }
});

test('API invalid JSON and unsuccessful responses have actionable errors', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<html>error</html>', { status: 502 });
    await assert.rejects(fetchJson('https://example.com'), /tidak valid/);
    globalThis.fetch = async () => Response.json({ success: false, error: 'Sumber offline' });
    await assert.rejects(fetchJson('https://example.com'), /Sumber offline/);
  } finally { globalThis.fetch = original; }
});

test('SRT and WebVTT subtitles parse timing and remove markup', () => {
  assert.deepEqual(parseSubtitleText('WEBVTT\n\n00:01.500 --> 00:03.000 align:start\n<b>Halo</b>'), [{ start: 1.5, end: 3, text: 'Halo' }]);
  assert.deepEqual(parseSubtitleText('1\n00:00:01,000 --> 00:00:02,000\nHalo'), [{ start: 1, end: 2, text: 'Halo' }]);
});

test('subtitle timing honors WebVTT timestamp maps and a saved viewer delay', () => {
  const cues = parseSubtitleText('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n00:01.000 --> 00:03.000\nHalo');
  assert.deepEqual(cues, [{ start: 11, end: 13, text: 'Halo' }]);
  assert.equal(subtitleTextAt(cues, 11.5), 'Halo');
  assert.equal(subtitleTextAt(cues, 11.5, 2), '');
  assert.equal(subtitleTextAt(cues, 13.5, 2), 'Halo');
  assert.equal(subtitleTextAt(cues, 9.5, -2), 'Halo');
});
