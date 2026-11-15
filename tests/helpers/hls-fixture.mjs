import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getFfmpegPath } from '../../src/lib/hls-transcode.js';

const exec = promisify(execFile);

export async function hlsFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cinebox-hls-test-'));
  const file = path.join(dir, 'hevc.mp4');
  try {
    await exec(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '180', '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-tag:v', 'hvc1',
      '-c:a', 'aac', '-movflags', '+faststart', file], { windowsHide: true, timeout: 60000 });
    const bytes = await readFile(file);
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.headers);
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); res.end(); return; }
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
      });
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { dir, file, requests, url: `http://127.0.0.1:${server.address().port}/hevc.mp4`,
      async close() {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      } };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
