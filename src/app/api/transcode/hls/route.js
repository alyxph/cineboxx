import { startHlsSession, buildHlsPlaylist } from '../../../../lib/hls-transcode.js';
import { hlsGateway } from '../../../../lib/hls-gateway.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export async function GET(request) {
  const gateway = await hlsGateway(request);
  if (gateway) return gateway;
  try {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get('url') || '';
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return new Response('Invalid url query parameter', { status: 400, headers: CORS_HEADERS });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return new Response('Unsupported protocol', { status: 400, headers: CORS_HEADERS });
    }

    const session = await startHlsSession({
      sessionId: searchParams.get('session') || '',
      targetUrl,
      height: searchParams.get('height') || 720,
      headers: {
        userAgent: searchParams.get('ua') || '',
        referer: searchParams.get('referer') || '',
        cookie: searchParams.get('cookie') || '',
        authorization: searchParams.get('authorization') || '',
        origin: searchParams.get('origin') || '',
      },
    });
    const body = buildHlsPlaylist(session);

    return new Response(body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Transcode': 'h264-hls',
        'X-Hls-Session': session.id,
        'X-Hls-Duration': String(session.duration),
      },
    });
  } catch (error) {
    return new Response(error.message || 'HLS transcode failed', {
      status: error.status || 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
