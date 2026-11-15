import { readHlsSegment } from '../../../../lib/hls-transcode.js';
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
  const { searchParams } = new URL(request.url);
  const sid = searchParams.get('sid') || '';
  const file = searchParams.get('file') || '';
  try {
    const data = await readHlsSegment(sid, file, request.signal);
    return new Response(data, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'video/mp2t',
        'Content-Length': String(data.length),
        'Cache-Control': 'private, max-age=300, immutable',
      },
    });
  } catch (error) {
    return new Response(error.message || 'Transcode segment failed', {
      status: error.name === 'AbortError' ? 499 : (error.status || 502),
      headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
    });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
