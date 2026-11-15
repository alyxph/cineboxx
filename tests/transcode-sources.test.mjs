import test from 'node:test';
import assert from 'node:assert/strict';
import { movieboxQualities, playbackSource, browserSupportsHevc } from '../src/lib/transcode-sources.js';
import { proxyUrl } from '../src/lib/playback.js';

const hevc = (height) => ({ name: `${height}p HEVC`, url: `https://cdn.example/${height}.mp4`, headers: { 'User-Agent': 'MovieBox' } });

test('only supplied resolutions appear once, with native H.264 preferred at the same height', () => {
  const sources = movieboxQualities([hevc(720), hevc(320),
    { name: '720p H.264', url: 'https://cdn.example/native.mp4' }]);
  assert.deepEqual(sources.map((s) => s.name), ['720p', '320p']);
  assert.equal(sources[0].url, 'https://cdn.example/native.mp4');
  assert.equal(sources[1].sourceCodec, 'hevc');
  assert.deepEqual(movieboxQualities([hevc(720)]).map((s) => s.name), ['720p']);
});

test('unsupported HEVC transparently transcodes at the selected resolution, including 1080p', () => {
  for (const height of [1080, 720, 320]) {
    const source = movieboxQualities([hevc(height)])[0];
    const playable = playbackSource(source, false);
    assert.equal(playable.originalSource, source);
    assert.equal(playable.name, `${height}p`);
    assert.equal(playable.url, source.url);
    assert.equal(playable.headers['User-Agent'], 'MovieBox');
    assert.equal(playable.headers['x-transcode-height'], String(height));
    assert.equal(new URL(proxyUrl(playable.url, playable.headers), 'https://local.example').searchParams.get('height'), String(height));
    assert.equal(playbackSource(source, true), source);
    assert.equal(playbackSource(source, true, true).headers['x-transcode-height'], String(height));
  }
});

test('native H.264 and disabled transcode stay direct; capability detection checks HEVC', () => {
  const source = movieboxQualities([{ name: '480p H.264', url: 'https://cdn.example/native.mp4' }])[0];
  assert.equal(playbackSource(source, false), source);
  const disabled = movieboxQualities([hevc(320)], false)[0];
  assert.equal(playbackSource(disabled, false), disabled);
  assert.equal(browserSupportsHevc({ canPlayType: () => '' }), false);
  assert.equal(browserSupportsHevc({ canPlayType: (type) => type.includes('hvc1') ? 'probably' : '' }), true);
});
