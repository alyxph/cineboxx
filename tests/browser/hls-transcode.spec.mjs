import { test, expect } from '@playwright/test';
import { hlsFixture } from '../helpers/hls-fixture.mjs';
import { movieboxQualities } from '../../src/lib/transcode-sources.js';

let fixture;
test.beforeAll(async () => { fixture = await hlsFixture(); });
test.afterAll(async () => { await fixture?.close(); });

async function mockMovie(page, multipleQualities = false, downlink = 20) {
  await page.addInitScript((downlink) => {
    const connection = Object.assign(new EventTarget(), { downlink, effectiveType: '4g', saveData: false });
    Object.defineProperty(navigator, 'connection', { configurable: true,
      value: connection });
    window.__setDownlink = (value) => { connection.downlink = value; connection.dispatchEvent(new Event('change')); };
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) { return /hvc1|hev1/.test(type) ? '' : original.call(this, type); };
  }, downlink);
  await page.route('**/api/catalog/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    const data = name === 'source' ? {
      // Provider duration is deliberately wrong: the probed duration must win.
      duration: 5400,
      streams: movieboxQualities((multipleQualities ? [720, 480, 320] : [144]).map((height) => ({ name: `${height}p HEVC`, url: `${fixture.url}?quality=${height}` }))),
    } : { title: 'HEVC Test', seasons: [], genres: [] };
    return route.fulfill({ json: { success: true, data } });
  });
}

test('HEVC HLS plays and seeks +10s, far, back and to the end without reloading the source', async ({ page, request }) => {
  test.setTimeout(120000);
  await mockMovie(page);
  const playlists = [];
  const errors = [];
  page.on('request', (req) => { if (req.url().includes('/api/transcode/hls?')) playlists.push(req.url()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/watch?id=hls-test&model_id=Test&type=movie&title=HEVC');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 60000 }).toBeGreaterThan(0.2);
  await expect.poll(() => video.evaluate((v) => v.videoWidth)).toBeGreaterThan(0);
  expect(await video.evaluate((v) => v.duration)).toBeCloseTo(180, 0);
  await video.evaluate((v) => v.pause());
  await expect.poll(() => video.evaluate((v) => v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0), { timeout: 30000 }).toBeGreaterThan(24);
  const src = await video.evaluate((v) => v.currentSrc);
  const time = await video.evaluate((v) => v.currentTime);
  await page.getByTitle('Maju 10 detik (l)', { exact: true }).click({ force: true });
  await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeCloseTo(time + 10, 0);
  await expect.poll(() => video.evaluate((v) => v.readyState)).toBeGreaterThanOrEqual(2);
  const timeline = page.locator('input[type=range][step="0.1"]');
  await timeline.fill('140');
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 30000 }).toBeCloseTo(140, 0);
  await video.evaluate((v) => v.play());
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 30000 }).toBeGreaterThan(140.2);
  await video.evaluate((v) => v.pause());
  await timeline.fill('8');
  await video.evaluate((v) => v.play());
  await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(8.2);
  await video.evaluate((v) => v.pause());
  await timeline.fill('178');
  await video.evaluate((v) => v.play());
  await expect.poll(() => video.evaluate((v) => v.ended), { timeout: 20000 }).toBe(true);
  expect(await video.evaluate((v) => v.currentSrc)).toBe(src);
  expect(playlists).toHaveLength(1);
  expect(errors).toEqual([]);
  const sid = new URL(playlists[0]).searchParams.get('session');
  await page.goto('/search');
  await expect.poll(async () => (await request.post(`/api/transcode/session?sid=${sid}`)).status()).toBe(410);
});

test('HEVC automatically transcodes selected 720p, 480p and 320p qualities and release the previous session', async ({ page, request }) => {
  test.setTimeout(120000);
  await mockMovie(page, true);
  const playlists = [];
  page.on('request', (req) => { if (req.url().includes('/api/transcode/hls?')) playlists.push(req.url()); });
  await page.goto('/watch?id=hls-qualities&model_id=Test&type=movie&title=HEVC');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v) => v.videoHeight), { timeout: 60000 }).toBe(720);
  for (const height of [480, 320]) {
    const previous = new URL(playlists.at(-1)).searchParams.get('session');
    await page.getByTitle('Setelan (Kualitas & Kecepatan)').click({ force: true });
    await page.getByText('Kualitas', { exact: true }).click();
    await page.getByText(`${height}p`, { exact: true }).click();
    await expect.poll(() => video.evaluate((v) => v.videoHeight), { timeout: 60000 }).toBe(height);
    await expect.poll(() => video.evaluate((v) => v.paused)).toBe(false);
    expect(new URL(playlists.at(-1)).searchParams.get('height')).toBe(String(height));
    await expect.poll(async () => (await request.post(`/api/transcode/session?sid=${previous}`)).status()).toBe(410);
  }
  await page.goto('/search');
});

test('Auto starts low on slow networks and selecting the current quality locks it without reloading', async ({ page }) => {
  test.setTimeout(90000);
  await mockMovie(page, true, 1);
  const playlists = [];
  page.on('request', (req) => { if (req.url().includes('/api/transcode/hls?')) playlists.push(req.url()); });
  await page.goto('/watch?id=auto-quality&model_id=Test&type=movie&title=HEVC');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 60000 }).toBeGreaterThan(0.2);
  expect(await video.evaluate((v) => v.videoHeight)).toBe(320);
  expect(playlists).toHaveLength(1);
  await page.getByTitle('Setelan (Kualitas & Kecepatan)').click({ force: true });
  await expect(page.getByText('Auto (320p)', { exact: true })).toBeVisible();
  await page.getByText('Kualitas', { exact: true }).click();
  await page.getByText('320p', { exact: true }).click();
  await page.evaluate(() => window.__setDownlink(30));
  await page.waitForTimeout(3500);
  expect(playlists).toHaveLength(1);
  await page.getByTitle('Setelan (Kualitas & Kecepatan)').click({ force: true });
  await expect(page.getByText('320p', { exact: true })).toBeVisible();
  await expect(page.getByText('Auto (320p)', { exact: true })).toHaveCount(0);
  await video.evaluate((v) => { v.pause(); v.currentTime = 20; });
  await expect.poll(() => video.evaluate((v) => v.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByText('Kualitas', { exact: true }).click();
  await page.getByText('720p', { exact: true }).click();
  await expect.poll(() => video.evaluate((v) => v.videoHeight), { timeout: 60000 }).toBe(720);
  await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeCloseTo(20, 0);
  expect(await video.evaluate((v) => v.paused)).toBe(true);
  await page.goto('/search');
});

test('HLS resume starts at the saved absolute position and tab close releases the session', async ({ page, context, request }) => {
  test.setTimeout(90000);
  await mockMovie(page);
  await page.addInitScript(() => {
    localStorage.setItem('cinebox_playback_progress', JSON.stringify({ 'hls-resume': { currentTime: 130, duration: 180 } }));
  });
  const playlists = [];
  page.on('request', (req) => { if (req.url().includes('/api/transcode/hls?')) playlists.push(req.url()); });
  await page.goto('/watch?id=hls-resume&model_id=Test&type=movie&title=HEVC');
  await expect.poll(() => page.locator('video').evaluate((v) => v.currentTime), { timeout: 60000 }).toBeGreaterThan(130);
  const sid = new URL(playlists[0]).searchParams.get('session');
  // Keep the browser context alive so close beacons can finish.
  await context.newPage();
  await page.close();
  await expect.poll(async () => (await request.post(`/api/transcode/session?sid=${sid}`)).status()).toBe(410);
});

test('Auto drops a stalled startup instead of waiting for the full HLS deadline', async ({ page }) => {
  test.setTimeout(90000);
  await mockMovie(page, true, 20);
  const heights = [];
  await page.route('**/api/transcode/hls?**', (route) => {
    const height = new URL(route.request().url()).searchParams.get('height');
    heights.push(height);
    if (height === '720') return;
    return route.continue();
  });
  await page.goto('/watch?id=auto-startup&model_id=Test&type=movie&title=HEVC');
  await expect.poll(() => page.locator('video').evaluate((v) => v.currentTime), { timeout: 30000 }).toBeGreaterThan(0.2);
  expect(heights.slice(0, 2)).toEqual(['720', '480']);
  expect(await page.locator('video').evaluate((v) => v.videoHeight)).toBe(480);
  await page.goto('/search');
});


test('HEVC capability false positives fall back silently at the same resolution', async ({ page }) => {
  test.setTimeout(90000);
  await mockMovie(page);
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) { return /hvc1|hev1/.test(type) ? 'probably' : original.call(this, type); };
  });
  await page.route('**/api/stream?**', (route) => route.fulfill({ contentType: 'video/mp4', body: 'unsupported codec' }));
  const playlists = [];
  page.on('request', (req) => { if (req.url().includes('/api/transcode/hls?')) playlists.push(req.url()); });
  await page.goto('/watch?id=hls-fallback&model_id=Test&type=movie&title=HEVC');
  await expect.poll(() => page.locator('video').evaluate((v) => v.currentTime), { timeout: 60000 }).toBeGreaterThan(0.2);
  expect(playlists).toHaveLength(1);
  expect(new URL(playlists[0]).searchParams.get('height')).toBe('144');
  await expect(page.getByText('Ganti ke H.264', { exact: true })).toHaveCount(0);
  await page.goto('/search');
});

test('audio-only HEVC playback recovers automatically through HLS and retains position', async ({ page }) => {
  test.setTimeout(90000);
  await mockMovie(page);
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) { return /hvc1|hev1/.test(type) ? 'probably' : original.call(this, type); };
    localStorage.setItem('cinebox_playback_progress', JSON.stringify({ 'audio-only': { currentTime: 20, duration: 180 } }));
  });
  // A real playable audio-only response reproduces time advancing with videoWidth=0.
  const wav = Buffer.alloc(44 + 8000 * 2 * 90);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route('**/api/stream?**', (route) => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) } });
  });
  const playlists = [];
  page.on('request', (req) => { if (req.url().includes('/api/transcode/hls?')) playlists.push(req.url()); });
  await page.goto('/watch?id=audio-only&model_id=Test&type=movie&title=HEVC');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((v) => v.videoHeight), { timeout: 60000 }).toBe(144);
  await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(20);
  expect(playlists).toHaveLength(1);
  await expect(page.getByText('Ganti ke H.264', { exact: true })).toHaveCount(0);
  await page.goto('/search');
});

test('HEVC without an available worker stops cleanly instead of launching legacy transcodes', async ({ page }) => {
  await mockMovie(page);
  await page.route('**/api/catalog/source?**', (route) => route.fulfill({ json: { success: true, data: {
    streams: movieboxQualities([{ name: '480p HEVC', url: fixture.url }], false),
  } } }));
  await page.route('**/api/stream?**', (route) => route.fulfill({ contentType: 'video/mp4', body: 'unsupported codec' }));
  const transcodes = [];
  page.on('request', (req) => { if (/transcode=h264|\/api\/transcode\//.test(req.url())) transcodes.push(req.url()); });
  await page.goto('/watch?id=no-worker&model_id=Test&type=movie&title=HEVC');
  await expect(page.locator('main').getByRole('alert')).toContainText('Video ini belum tersedia dalam format yang dapat diputar di perangkat ini.');
  expect(transcodes).toEqual([]);
  await expect(page.getByText('Ganti ke H.264', { exact: true })).toHaveCount(0);
  await page.goto('/search');
});
