import { timingSafeEqual } from 'node:crypto';
import { isHlsTranscodingEnabled } from './hls-transcode.js';

function workerUrl() {
  if (!process.env.HLS_WORKER_URL || !process.env.HLS_WORKER_TOKEN) return null;
  try {
    const url = new URL(process.env.HLS_WORKER_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url;
  } catch { return null; }
}

export function isHlsPlaybackAvailable() {
  return process.env.HLS_WORKER_URL ? Boolean(workerUrl()) : isHlsTranscodingEnabled();
}

const message = (text, status) => new Response(text, { status, headers: { 'Cache-Control': 'no-store' } });

// A configured worker runs this same app on one persistent Node/Docker instance.
// Only the server knows its credential; playlist/segment URLs remain same-origin.
export async function hlsGateway(request) {
  const remote = workerUrl();
  const incoming = new URL(request.url);
  if (process.env.HLS_WORKER_URL && !remote) return message('Konfigurasi layanan video belum lengkap.', 503);
  if (remote) {
    if (remote.origin === incoming.origin || request.headers.has('x-cinebox-hls-hop')) return message('Konfigurasi layanan video berulang.', 503);
    const allowed = { '/api/transcode/hls': ['GET', 'HEAD'], '/api/transcode/segment': ['GET', 'HEAD'], '/api/transcode/session': ['POST', 'DELETE'] };
    if (!allowed[incoming.pathname]?.includes(request.method)) return message('Invalid transcode request', 400);
    const target = new URL(incoming.pathname + incoming.search, remote);
    try {
      const response = await fetch(target, {
        method: request.method, redirect: 'error', cache: 'no-store',
        headers: { Authorization: `Bearer ${process.env.HLS_WORKER_TOKEN}`, 'x-cinebox-hls-hop': '1' },
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(55000)]),
      });
      if (response.status >= 500 || [401, 403].includes(response.status)) {
        await response.body?.cancel();
        return message('Layanan penyiapan video belum tersedia. Coba lagi nanti.', 503);
      }
      const headers = new Headers({ 'Cache-Control': 'no-store' });
      for (const key of ['content-type', 'x-hls-session', 'x-hls-duration', 'x-transcode']) {
        if (response.headers.has(key)) headers.set(key, response.headers.get(key));
      }
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return message('Layanan penyiapan video tidak merespons.', 504);
    }
  }
  const token = process.env.HLS_WORKER_TOKEN;
  if (token) {
    const actual = Buffer.from(request.headers.get('authorization') || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return message('Unauthorized', 401);
  }
  return null;
}
