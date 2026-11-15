import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const STORE_KEY = Symbol.for('cinebox.hls.manager.v2');
export const HLS_SEGMENT_SECONDS = 4;
const SESSION_ID = /^[A-Za-z0-9_-]{16,80}$/;

export class HlsError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function isHlsTranscodingEnabled() {
  // Separate serverless functions cannot share a child process or local cache.
  return process.env.HLS_TRANSCODE_ENABLED !== '0' && !process.env.VERCEL;
}

export function getFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const direct = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', binary);
  if (fs.existsSync(direct)) return direct;
  try {
    const binaryPath = require('ffmpeg-static');
    if (binaryPath && fs.existsSync(binaryPath)) return binaryPath;
  } catch { /* An OS installation on PATH is also supported. */ }
  return 'ffmpeg';
}

function positive(value, fallback, min = 1) {
  return Number.isFinite(Number(value)) && Number(value) >= min ? Number(value) : fallback;
}

function inputArgs(url, headers) {
  const lines = Object.entries({
    'User-Agent': headers.userAgent || 'Mozilla/5.0',
    Referer: headers.referer, Cookie: headers.cookie,
    Origin: headers.origin, Authorization: headers.authorization,
  }).filter(([, value]) => value).map(([name, value]) => {
    if (/[\r\n\0]/.test(String(value))) throw new HlsError('Header stream tidak valid.', 400);
    return `${name}: ${value}\r\n`;
  });
  return ['-threads', '2', '-rw_timeout', '15000000', '-protocol_whitelist', 'http,https,tcp,tls',
    '-headers', lines.join(''), '-i', url];
}

function launch(binary, args, cwd) {
  const child = spawn(/* turbopackIgnore: true */ binary, args, {
    cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const job = { child, stderr: '', error: null, ended: false, cancelled: false };
  child.stderr.on('data', (data) => { job.stderr = (job.stderr + data).slice(-16000); });
  job.done = new Promise((resolve) => {
    child.on('error', () => { job.error = new HlsError('ffmpeg tidak tersedia atau gagal dijalankan.'); });
    child.on('close', (code) => { job.code = code; job.ended = true; resolve(); });
  });
  return job;
}

async function stop(job) {
  if (!job || job.ended) return;
  job.cancelled = true;
  job.child.kill('SIGKILL');
  await job.done;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One persistent Node process owns the sessions. A VOD playlist fixes the media
// timeline; uncached TS segments trigger a bounded, seekable encode window.
// TS avoids changing fMP4 init fragments when a window starts after a far seek.
export function createHlsManager(options = {}) {
  const sessions = new Map();
  const closedIds = new Map();
  const maxSessions = positive(options.maxSessions ?? process.env.HLS_MAX_SESSIONS, 4);
  const idleMs = positive(options.idleMs ?? process.env.HLS_SESSION_IDLE_MS, 5 * 60 * 1000);
  const cacheBytes = positive(options.cacheBytes ?? process.env.HLS_CACHE_BYTES, 256 * 1024 * 1024);
  const timeoutMs = positive(options.timeoutMs, 45000);
  const windowSegments = 15;
  const binary = options.ffmpegPath || getFfmpegPath();
  const root = options.tempRoot || os.tmpdir();

  function lookup(id) {
    const session = sessions.get(String(id));
    if (!session || session.closed) throw new HlsError('Sesi HLS telah berakhir. Muat ulang pemutar.', 410);
    session.lastAccess = Date.now();
    return session;
  }

  async function release(id) {
    closedIds.set(String(id), Date.now());
    const session = sessions.get(String(id));
    if (!session) return;
    if (session.cleanup) return session.cleanup;
    session.closed = true;
    session.cleanup = (async () => {
      await Promise.all([stop(session.probe), stop(session.job)]);
      await session.initialized?.catch(() => {});
      await session.queue.catch(() => {});
      await session.job?.collecting;
      if (session.dir) await fsp.rm(session.dir, { recursive: true, force: true, maxRetries: 3 });
      if (sessions.get(session.id) === session) sessions.delete(session.id);
    })();
    return session.cleanup;
  }

  async function sweep(now = Date.now()) {
    for (const [id, closedAt] of closedIds) if (now - closedAt > idleMs) closedIds.delete(id);
    await Promise.all([...sessions.values()].filter((s) => now - s.lastAccess > idleMs).map((s) => release(s.id)));
  }
  const timer = setInterval(() => { sweep().catch(() => {}); }, Math.min(idleMs, 30000));
  timer.unref?.();

  async function start({ sessionId, targetUrl, height = 720, headers = {} }) {
    if (!SESSION_ID.test(String(sessionId || ''))) throw new HlsError('ID sesi HLS tidak valid.', 400);
    if (closedIds.has(sessionId)) throw new HlsError('Sesi HLS telah ditutup.', 410);
    let url;
    try { url = new URL(targetUrl); } catch { throw new HlsError('URL stream tidak valid.', 400); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new HlsError('Protokol URL stream tidak didukung.', 400);
    }
    const outputHeight = Number(height) > 0 ? Math.max(2, Math.min(4320, Math.floor(positive(height, 720) / 2) * 2)) : 0;
    const sourceArgs = inputArgs(url.href, headers);
    const identity = JSON.stringify([url.href, outputHeight, sourceArgs]);
    const existing = sessions.get(sessionId);
    if (existing) {
      if (existing.closed) throw new HlsError('Sesi HLS telah ditutup.', 410);
      if (existing.identity !== identity) throw new HlsError('ID sesi sudah digunakan stream lain.', 409);
      existing.lastAccess = Date.now();
      return existing.initialized;
    }
    if (sessions.size >= maxSessions) throw new HlsError('Server transcode sedang penuh. Coba lagi sesaat lagi.', 503);
    // Reserve before awaiting so concurrent playlist requests cannot spawn duplicates.
    const session = { id: sessionId, identity, height: outputHeight, sourceArgs,
      lastAccess: Date.now(), closed: false, cache: new Map(), bytes: 0, queue: Promise.resolve() };
    sessions.set(sessionId, session);
    session.initialized = (async () => {
      session.dir = await fsp.mkdtemp(path.join(root, 'cinebox-hls-'));
      if (session.closed) throw new HlsError('Sesi HLS telah ditutup.', 410);
      const probe = launch(binary, ['-hide_banner', '-nostdin', ...sourceArgs], session.dir);
      session.probe = probe;
      const deadline = setTimeout(() => { stop(probe).catch(() => {}); }, Math.min(timeoutMs, 20000));
      await probe.done;
      clearTimeout(deadline);
      if (session.closed) throw new HlsError('Sesi HLS telah ditutup.', 410);
      if (probe.error) throw probe.error;
      const match = probe.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
      if (duration <= 0 || duration > 86400) throw new HlsError('Durasi stream tidak dapat dibaca untuk transcode HLS.');
      session.duration = duration;
      if (!session.height) {
        const dimensions = probe.stderr.match(/Video:[^\n]*?\b\d{2,5}x(\d{2,5})\b/);
        session.height = dimensions ? Math.floor(Number(dimensions[1]) / 2) * 2 : 720;
      }
      session.count = Math.ceil(duration / HLS_SEGMENT_SECONDS);
      return session;
    })();
    try { return await session.initialized; }
    catch (error) {
      if (!session.closed) await release(session.id);
      throw error;
    }
  }

  function playlist(session) {
    lookup(session.id);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (let i = 0; i < session.count; i++) {
      const duration = Math.min(HLS_SEGMENT_SECONDS, session.duration - i * HLS_SEGMENT_SECONDS);
      lines.push(`#EXTINF:${duration.toFixed(3)},`,
        `/api/transcode/segment?${new URLSearchParams({ sid: session.id, file: `seg${String(i).padStart(6, '0')}.ts` })}`);
    }
    return lines.concat('#EXT-X-ENDLIST', '').join('\n');
  }

  async function collect(session, job) {
    const names = await fsp.readdir(job.dir);
    for (const name of names) {
      if (!/^seg\d{6}\.ts$/.test(name)) continue;
      const index = Number(name.slice(3, 9));
      const filePath = path.join(job.dir, name);
      const cached = session.cache.get(index);
      if (cached) {
        if (cached.path !== filePath) await fsp.unlink(filePath).catch(() => {});
        continue;
      }
      const stat = await fsp.stat(filePath);
      session.cache.set(index, { path: filePath, size: stat.size, used: Date.now() });
      session.bytes += stat.size;
    }
    for (const [index, entry] of [...session.cache].sort((a, b) => a[1].used - b[1].used)) {
      if (session.bytes <= cacheBytes) break;
      if (session.waiters?.has(index)) continue;
      session.cache.delete(index);
      session.bytes -= entry.size;
      await fsp.unlink(entry.path).catch(() => {});
    }
  }

  async function ensureJob(session, index) {
    session.queue = session.queue.catch(() => {}).then(async () => {
      if (session.closed) throw new HlsError('Sesi HLS telah ditutup.', 410);
      if (session.cache.has(index)) return session.job;
      let job = session.job;
      if (job && index >= job.first && index < job.last && !job.ended) return job;
      if (job) {
        await stop(job);
        await job.collecting;
        await collect(session, job);
        if (session.cache.has(index)) return job;
      }
      const dir = await fsp.mkdtemp(path.join(session.dir, 'window-'));
      if (session.closed) throw new HlsError('Sesi HLS telah ditutup.', 410);
      const start = index * HLS_SEGMENT_SECONDS;
      const length = Math.min(windowSegments * HLS_SEGMENT_SECONDS, session.duration - start);
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-ss', String(start), ...session.sourceArgs, '-t', String(length),
        '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
        '-vf', `scale=-2:${session.height}`, '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-threads', '2',
        '-r', '30', '-g', '120', '-keyint_min', '120', '-sc_threshold', '0',
        '-force_key_frames', 'expr:gte(t,n_forced*4)', '-maxrate', '2500k', '-bufsize', '5000k',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
        '-output_ts_offset', String(start), '-f', 'hls', '-hls_time', '4',
        '-hls_list_size', '0', '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts',
        '-hls_flags', 'independent_segments+temp_file', '-start_number', String(index),
        '-hls_segment_filename', path.join(dir, 'seg%06d.ts'), path.join(dir, 'index.m3u8')];
      job = Object.assign(launch(binary, args, dir), { dir, first: index,
        last: Math.min(session.count, index + windowSegments), collecting: Promise.resolve() });
      session.job = job;
      const lifetime = setTimeout(() => { stop(job).catch(() => {}); }, 120000);
      const scan = async () => {
        try { await collect(session, job); } catch (error) { if (!session.closed) job.error = error; }
      };
      const scanTimer = setInterval(() => { job.collecting = job.collecting.then(scan); }, 250);
      job.done.then(async () => {
        clearTimeout(lifetime);
        clearInterval(scanTimer);
        job.collecting = job.collecting.then(scan);
        await job.collecting;
        // A killed window can leave an unfinished segment; it is never cacheable.
        const names = await fsp.readdir(job.dir).catch(() => []);
        await Promise.all(names.filter((name) => !/^seg\d{6}\.ts$/.test(name))
          .map((name) => fsp.unlink(path.join(job.dir, name)).catch(() => {})));
      });
      return job;
    });
    return session.queue;
  }

  async function segment(id, file, signal) {
    if (!/^seg\d{6}\.ts$/.test(String(file))) throw new HlsError('Nama segmen tidak valid.', 400);
    const session = lookup(id);
    await session.initialized;
    const index = Number(file.slice(3, 9));
    if (index >= session.count) throw new HlsError('Segmen tidak ditemukan.', 404);
    signal?.throwIfAborted();
    session.waiters ||= new Map();
    session.waiters.set(index, (session.waiters.get(index) || 0) + 1);
    try {
      const job = session.cache.has(index) ? null : await ensureJob(session, index);
      const deadline = Date.now() + timeoutMs;
      while (!session.closed && Date.now() < deadline) {
        signal?.throwIfAborted();
        const entry = session.cache.get(index);
        if (entry) {
          entry.used = session.lastAccess = Date.now();
          return await fsp.readFile(entry.path);
        }
        if (job?.ended) {
          await job.collecting;
          if (session.cache.has(index)) continue;
          throw job.error || new HlsError(job.cancelled ? 'Permintaan segmen digantikan seek baru.' : 'Transcode segmen gagal.', job.cancelled ? 409 : 502);
        }
        await delay(100);
      }
      if (session.closed) throw new HlsError('Sesi HLS telah ditutup.', 410);
      await stop(job);
      throw new HlsError('Transcode segmen melewati batas waktu.', 504);
    } finally {
      const remaining = session.waiters.get(index) - 1;
      if (remaining) session.waiters.set(index, remaining);
      else session.waiters.delete(index);
    }
  }

  return { start, playlist, segment, release, touch: (id) => lookup(id), sweep,
    async close() { clearInterval(timer); await Promise.all([...sessions.keys()].map(release)); } };
}

function manager() {
  return globalThis[STORE_KEY] ||= createHlsManager();
}

export async function startHlsSession(input) {
  if (!isHlsTranscodingEnabled()) throw new HlsError('Transcode HLS memerlukan server Node/Docker persisten.', 503);
  return manager().start(input);
}
export const buildHlsPlaylist = (session) => manager().playlist(session);
export const readHlsSegment = (id, file, signal) => manager().segment(id, file, signal);
export const releaseHlsSession = (id) => manager().release(id);
export const touchHlsSession = (id) => manager().touch(id);
