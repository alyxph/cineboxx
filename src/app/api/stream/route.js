import { spawn } from 'node:child_process';
import { getFfmpegPath } from '../../../lib/hls-transcode.js';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get('url');
    const referer = searchParams.get('referer') || '';
    const userAgent = searchParams.get('ua') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const cookie = searchParams.get('cookie') || '';
    const origin = searchParams.get('origin') || '';
    const authorization = searchParams.get('authorization') || '';
    const transcode = searchParams.get('transcode') || '';
    const seekSeconds = parseFloat(searchParams.get('ss') || '0') || 0;

    if (!targetUrl) {
      return new Response('Missing url query parameter', { status: 400 });
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return new Response('Invalid url query parameter', { status: 400 });
    }
    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      return new Response('Unsupported protocol', { status: 400 });
    }

    const validateTarget = (value) => {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
          /^(localhost|0\.|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(host)) throw Object.assign(new Error('Unsupported stream target'), { status: 400 });
    };
    try { validateTarget(targetUrl); } catch { return new Response('Unsupported stream target', { status: 400 }); }
    const isBili =
      targetUrl.includes('bilivideo.com') ||
      targetUrl.includes('akamaized.net') ||
      targetUrl.includes('bstarstatic.com') ||
      targetUrl.includes('bilibili.');

    const isMovieBox =
      targetUrl.includes('hakunaymatata.com') ||
      targetUrl.includes('aoneroom.com') ||
      targetUrl.includes('inmoviebox.com') ||
      targetUrl.includes('sportslive.wine') ||
      targetUrl.includes('vidio-ugc.com') ||
      targetUrl.includes('fzmovies.cms') ||
      targetUrl.includes('m-stream.') ||
      targetUrl.includes('wefeed-');

    let effectiveUserAgent = userAgent;
    let effectiveReferer = referer;

    if (isBili) {
      effectiveUserAgent = 'Bilibili Freedome/1.0.0 (Android; 13)';
      effectiveReferer = ''; // Do not send desktop referer to avoid 403 on Bilibili CDNs
    } else if (isMovieBox) {
      effectiveUserAgent = 'MovieBox/4.0.02 (Android 14; Pixel 6)';
      effectiveReferer = ''; // Do not send desktop or local referer to avoid 428/403 on MovieBox CDNs
    }

    const headers = {
      'User-Agent': effectiveUserAgent,
    };
    if (effectiveReferer) {
      headers['Referer'] = effectiveReferer;
      try {
        headers['Origin'] = origin || new URL(effectiveReferer).origin;
      } catch {}
    } else if (origin) {
      headers['Origin'] = origin;
    }
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    if (authorization) {
      headers['Authorization'] = authorization;
    }

    // On-the-fly H.264 real-time transcode for HEVC / unsupported codecs across all browsers & devices
    const ffmpegBin = getFfmpegPath();
    if (transcode === 'h264' && ffmpegBin) {
      const ffmpegArgs = [
        '-headers', `User-Agent: ${effectiveUserAgent}\r\n`,
      ];
      if (seekSeconds > 0) {
        ffmpegArgs.push('-ss', String(seekSeconds));
      }
      ffmpegArgs.push(
        '-i', targetUrl,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '26',
        '-c:a', 'copy',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'
      );

      const ff = spawn(/*turbopackIgnore: true*/ ffmpegBin, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let streamClosed = false;

      const transcodeStream = new ReadableStream({
        start(controller) {
          ff.stdout.on('data', (chunk) => {
            if (!streamClosed) {
              try { controller.enqueue(chunk); } catch { streamClosed = true; }
            }
          });
          ff.stdout.on('end', () => {
            if (!streamClosed) {
              streamClosed = true;
              try { controller.close(); } catch {}
            }
          });
          ff.on('error', (err) => {
            if (!streamClosed) {
              streamClosed = true;
              try { controller.error(err); } catch {}
            }
          });
          ff.stderr.on('data', () => {});
        },
        cancel() {
          streamClosed = true;
          try { ff.kill('SIGKILL'); } catch {}
        },
      });

      request.signal?.addEventListener('abort', () => {
        streamClosed = true;
        try { ff.kill('SIGKILL'); } catch {}
      });

      return new Response(transcodeStream, {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'X-Transcode': 'h264',
        },
      });
    }

    // Forward range header for video seeking support
    const range = request.headers.get('range');
    if (range) {
      headers['Range'] = range;
    }

    let upstreamUrl = targetUrl;
    const fetchUpstream = async (url, options) => {
      for (let redirects = 0; redirects < 6; redirects++) {
        validateTarget(url);
        const response = await fetch(url, { ...options, redirect: 'manual', signal: request.signal });
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
          const next = new URL(response.headers.get('location'), url).href;
          await response.body?.cancel(); validateTarget(next); url = next; continue;
        }
        upstreamUrl = response.url || url; return response;
      }
      throw new Error('Too many stream redirects');
    };
    let upstreamResponse;
    try {
      upstreamResponse = await fetchUpstream(targetUrl, {
        headers,
        redirect: 'follow',
        cache: 'no-store',
      });

      // If upstream rejects with 428 or 403, retry with mobile ExoPlayer UA and stripped referer
      if (!upstreamResponse.ok && (upstreamResponse.status === 428 || upstreamResponse.status === 403)) {
        try {
          const retryHeaders = {
            ...headers,
            'User-Agent': 'ExoPlayerLib/2.18.1',
          };
          delete retryHeaders['Referer'];
          delete retryHeaders['Origin'];
          const retryRes = await fetchUpstream(targetUrl, {
            headers: retryHeaders,
            redirect: 'follow',
            cache: 'no-store',
          });
          if (retryRes.ok) {
            upstreamResponse = retryRes;
          }
        } catch (retryErr) {
          console.warn('Stream proxy retry error:', retryErr.message);
        }
      }
    } catch (fetchErr) {
      if (fetchErr.status === 400) return new Response('Unsupported redirect target', { status: 400 });
      console.warn('Stream proxy upstream connection error:', fetchErr.message);
      return new Response(JSON.stringify({ error: 'channel_offline', message: 'Saluran saat ini sedang offline' }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Stream-Offline': 'true',
        },
      });
    }

    const contentType = upstreamResponse.headers.get('content-type') || 'application/octet-stream';
    const responseHeaders = new Headers();

    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('Access-Control-Expose-Headers', 'X-Stream-Url');
    responseHeaders.set('X-Stream-Url', upstreamUrl);
    responseHeaders.set('Cache-Control', 'no-store');

    if (!upstreamResponse.ok && upstreamResponse.status >= 400) {
      const contentRange = upstreamResponse.headers.get('content-range');
      if (contentRange) responseHeaders.set('Content-Range', contentRange);
      return new Response(upstreamResponse.body, { status: upstreamResponse.status, headers: responseHeaders });
    }

    const isM3u8 =
      targetUrl.toLowerCase().includes('.m3u8') ||
      contentType.toLowerCase().includes('application/vnd.apple.mpegurl') ||
      contentType.toLowerCase().includes('application/x-mpegurl');

    const isMpd =
      targetUrl.toLowerCase().includes('.mpd') ||
      contentType.toLowerCase().includes('application/dash+xml') ||
      contentType.toLowerCase().includes('video/vnd.mpeg.dash.mpd');

    // If HLS playlist, rewrite all relative/absolute segment, media, map, and key URLs to go through proxy
    if (isM3u8) {
      const text = await upstreamResponse.text();
      if (!text.trimStart().startsWith('#EXTM3U')) return new Response('Invalid HLS playlist', { status: 502 });
      const parentUrl = new URL(upstreamUrl);

      const toProxyUrl = (rawUri) => {
        const absUrl = new URL(rawUri, parentUrl).toString();
        const p = new URLSearchParams();
        p.set('url', absUrl);
        if (referer) p.set('referer', referer);
        if (userAgent) p.set('ua', userAgent);
        if (cookie) p.set('cookie', cookie);
        if (origin) p.set('origin', origin);
        if (authorization) p.set('authorization', authorization);
        return `/api/stream?${p.toString()}`;
      };

      const lines = text.split('\n');
      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Rewrite URI="..." inside HLS tags (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, etc.)
        if (trimmed.startsWith('#')) {
          if (!/URI=(["'])([^"']+)\1/.test(trimmed)) return line;
          return trimmed.replace(/URI=(["'])([^"']+)\1/g, (match, quote, uri) => {
            try {
              return `URI=${quote}${toProxyUrl(uri)}${quote}`;
            } catch {
              return match;
            }
          });
        }

        // Rewrite media chunk segment or child playlist URL
        try {
          return toProxyUrl(trimmed);
        } catch {
          return line;
        }
      });

      const rewrittenContent = rewrittenLines.join('\n');
      responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
      responseHeaders.set('Content-Length', Buffer.byteLength(rewrittenContent).toString());

      return new Response(rewrittenContent, {
        status: 200,
        headers: responseHeaders,
      });
    }

    if (isMpd) {
      responseHeaders.set('Content-Type', 'application/dash+xml');
    } else if ((!contentType || contentType.includes('application/octet-stream') || contentType.includes('binary/octet-stream')) && /\.mp4($|\?)/i.test(targetUrl)) {
      responseHeaders.set('Content-Type', 'video/mp4');
    } else {
      responseHeaders.set('Content-Type', contentType);
    }

    responseHeaders.set('Accept-Ranges', 'bytes');

    const contentRange = upstreamResponse.headers.get('content-range');
    if (contentRange) responseHeaders.set('Content-Range', contentRange);

    const contentLength = upstreamResponse.headers.get('content-length');
    if (contentLength && !upstreamResponse.headers.get('content-encoding')) responseHeaders.set('Content-Length', contentLength);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error('Stream proxy error:', err);
    return new Response(`Proxy Error: ${err.message}`, { status: 502 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  });
}

export const HEAD = GET;
