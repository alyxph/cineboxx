import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = readFileSync(new URL('../fixtures/playback.webm', import.meta.url));
const channels = ['a', 'b', 'c'].map((id) => ({ id, title: `Channel ${id.toUpperCase()}`, modelId: 'CineTv', type: 'live' }));
const watch = (id = 'a', live = true) => `/watch?${new URLSearchParams({ id, model_id: live ? 'CineTv' : 'Test', type: live ? 'live' : 'movie', title: live ? `Channel ${id.toUpperCase()}` : 'Test Movie' })}`;

async function mockApi(page, source, { channelDelay = 0 } = {}) {
  const requests = [];
  await page.route('**/api/catalog/**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split('/').at(-1);
    let response = { success: true };
    if (name === 'categories') response.data = [{ id: 'ID', name: 'Indonesia' }];
    if (name === 'sources') response.data = [{ id: 'CineTv', name: 'Live TV' }];
    if (name === 'videos') {
      if (channelDelay) await new Promise((resolve) => setTimeout(resolve, channelDelay));
      response.videos = channels;
      response.hasMore = false;
    }
    if (name === 'detail') response.data = { title: 'Test Movie', seasons: [], genres: [] };
    if (name === 'source') {
      const id = url.searchParams.get('id');
      requests.push(id);
      response = await source(id, requests.length);
      if (response === null) return; // Deliberately leave the request pending for deadline tests.
    }
    await route.fulfill({ json: response });
  });
  return requests;
}

const playable = { success: true, data: { streams: [{ url: 'https://media.example/test.webm', format: 'webm' }] } };
const offline = { success: true, data: { streams: [] } };
async function media(page) {
  await page.route('**/api/stream?**', (route) => route.fulfill({ status: 200, contentType: 'video/webm', body: fixture }));
}

test('offline TV shows the reason and automatically plays the next channel', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = await mockApi(page, (id) => id === 'a' ? offline : playable);
  await media(page);
  await page.goto(watch());
  await expect(page).toHaveURL(/id=b/);
  await expect(page.getByRole('status')).toContainText('Beralih otomatis ke Channel B');
  await expect.poll(() => page.locator('video').evaluate((video) => video.currentTime)).toBeGreaterThan(0.1);
  expect(requests.slice(0, 2)).toEqual(['a', 'b']);
  expect(errors).toEqual([]);
});

test('all channels offline stops after one pass instead of looping', async ({ page }) => {
  const requests = await mockApi(page, () => offline);
  await page.goto(watch());
  await expect(page.getByRole('status')).toContainText('Semua saluran dalam daftar ini sudah dicoba');
  await page.waitForTimeout(1600);
  expect(requests).toEqual(['a', 'b', 'c']);
  await expect(page.getByText('Menghubungkan ke pemutar...')).toHaveCount(0);
});

test('failed source waits for the channel list before choosing the next channel', async ({ page }) => {
  await mockApi(page, (id) => id === 'a' ? offline : playable, { channelDelay: 1500 });
  await media(page);
  await page.goto(watch());
  await expect(page).toHaveURL(/id=b/);
});

test('a source request that never finishes times out and advances', async ({ page }) => {
  await mockApi(page, (id) => id === 'a' ? null : playable);
  await media(page);
  await page.goto(watch());
  await expect(page).toHaveURL(/id=b/, { timeout: 18000 });
  await expect(page.getByRole('status')).toContainText('tidak merespons tepat waktu');
});

test('buffering past the startup deadline advances to the next channel', async ({ page }) => {
  await mockApi(page, (id) => id === 'a' ? { success: true, data: { streams: [{ url: 'https://media.example/hanging.webm' }] } } : playable);
  await page.route('**/api/stream?**', (route) => {
    if (route.request().url().includes('hanging')) return;
    return route.fulfill({ contentType: 'video/webm', body: fixture });
  });
  await page.goto(watch());
  await expect(page).toHaveURL(/id=b/, { timeout: 18000 });
  await expect(page.getByRole('status')).toContainText('batas waktu');
});

test('autoplay rejection requests user input without marking TV offline', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
  });
  const requests = await mockApi(page, () => playable);
  await media(page);
  await page.goto(watch());
  await expect(page.getByText('Tekan Play untuk mulai menonton.')).toBeVisible();
  await page.waitForTimeout(13000);
  expect(requests).toEqual(['a']);
  await expect(page).toHaveURL(/id=a/);
  await expect(page.locator('.player-inline').getByRole('alert')).toHaveCount(0);
});

test('browser offline reports connection failure without cycling through channels', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  const requests = await mockApi(page, () => offline);
  await page.goto(watch());
  await expect(page.locator('.player-inline').getByRole('alert')).toContainText('Koneksi internet terputus');
  await page.waitForTimeout(1200);
  expect(requests).toEqual(['a']);
});

test('video source fallback plays a second URL and speed changes do not refetch it', async ({ page }) => {
  const requests = await mockApi(page, () => ({ success: true, data: { streams: [
    { name: 'Broken', url: 'https://media.example/broken.webm' },
    { name: 'Working', url: 'https://media.example/test.webm' },
  ] } }));
  let mediaRequests = 0;
  await page.route('**/api/stream?**', (route) => {
    mediaRequests++;
    return route.request().url().includes('broken') ? route.fulfill({ status: 404, body: 'Offline' }) : route.fulfill({ contentType: 'video/webm', body: fixture });
  });
  await page.goto(watch('movie', false));
  await expect.poll(() => page.locator('video').evaluate((video) => video.currentTime)).toBeGreaterThan(0.1);
  await page.getByTitle('Setelan (Kualitas & Kecepatan)').click();
  await page.getByText('Kecepatan Putar', { exact: true }).click();
  await page.getByText('1.5x', { exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video) => video.playbackRate)).toBe(1.5);
  expect(requests).toEqual(['movie']);
  expect(mediaRequests).toBe(2);
});

test('HTTP source errors can be retried without leaving stale media state', async ({ page }) => {
  const requests = await mockApi(page, (_, count) => count === 1 ? { success: false, error: 'Server sementara gagal' } : playable);
  await media(page);
  await page.goto(watch('movie', false));
  await expect(page.locator('.player-inline').getByRole('alert')).toContainText('Server sementara gagal');
  await page.getByRole('button', { name: 'Coba Lagi', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video) => video.currentTime)).toBeGreaterThan(0.1);
  expect(requests).toEqual(['movie', 'movie']);
  await expect(page.locator('.player-inline').getByRole('alert')).toHaveCount(0);
});

test('blocked local storage does not prevent home navigation', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
  });
  await mockApi(page, () => playable);
  await media(page);
  await page.goto('/');
  await page.getByTitle('Channel A', { exact: true }).click();
  await expect(page).toHaveURL(/\/watch\?/);
});

test('a loaded external player is not falsely reported as unresponsive', async ({ page }) => {
  await mockApi(page, () => ({ success: true, data: { streams: [{ format: 'iframe', url: 'https://media.example/embed/test' }] } }));
  await page.route('https://media.example/embed/test', (route) => route.fulfill({ contentType: 'text/html', body: '<p>External player loaded</p>' }));
  await page.goto(watch('movie', false));
  await expect(page.frameLocator('iframe').getByText('External player loaded')).toBeVisible();
  await page.waitForTimeout(13000);
  await expect(page.getByText(/Pemutar eksternal belum merespons/)).toHaveCount(0);
});
