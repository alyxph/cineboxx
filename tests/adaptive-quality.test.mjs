import test from 'node:test';
import assert from 'node:assert/strict';
import { initialQuality, adaptiveQuality } from '../src/lib/adaptive-quality.js';
const streams = [1080, 720, 480, 320].map((resolution) => ({ resolution, name: `${resolution}p`, url: `https://cdn.example/${resolution}.mp4` }));
test('startup follows estimated bandwidth and uses a moderate quality when unknown', () => {
  assert.equal(initialQuality(streams, null).resolution, 480);
  assert.equal(initialQuality(streams, { downlink: 20 }).resolution, 1080);
  assert.equal(initialQuality(streams, { downlink: 2 }).resolution, 320);
  assert.equal(initialQuality(streams, { downlink: 20, saveData: true }).resolution, 320);
  assert.equal(initialQuality([{ name: 'Unknown', url: 'https://cdn.example/video' }], null).name, 'Unknown');
});
const health = { streams, current: streams[1], bufferAhead: 0, waitingMs: 4000,
  stableMs: 0, sinceSwitchMs: 15000, playing: true, seeking: false, playbackSeconds: 60 };
test('buffer starvation lowers quality and cooldown prevents repeated reloads', () => {
  assert.equal(adaptiveQuality(health).resolution, 480);
  assert.equal(adaptiveQuality({ ...health, sinceSwitchMs: 5000 }), null);
  assert.equal(adaptiveQuality({ ...health, playing: false }), null);
  assert.equal(adaptiveQuality({ ...health, seeking: true }), null);
  assert.equal(adaptiveQuality({ ...health, connection: { downlink: 1 } }).resolution, 320);
});
test('upgrades require sustained headroom and move one step at a time', () => {
  const stable = { ...health, current: streams[2], bufferAhead: 45, waitingMs: 0,
    stableMs: 50000, sinceSwitchMs: 95000, connection: { downlink: 30 } };
  assert.equal(adaptiveQuality(stable).resolution, 720);
  assert.equal(adaptiveQuality({ ...stable, playbackSeconds: 10 }), null);
  assert.equal(adaptiveQuality({ ...stable, stableMs: 10000 }), null);
  assert.equal(adaptiveQuality({ ...stable, sinceSwitchMs: 30000 }), null);
  assert.equal(adaptiveQuality({ ...stable, connection: { downlink: 3 } }), null);
});
