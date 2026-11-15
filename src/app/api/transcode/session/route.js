import { releaseHlsSession, touchHlsSession } from '../../../../lib/hls-transcode.js';
import { hlsGateway } from '../../../../lib/hls-gateway.js';

export const runtime = 'nodejs';

// POST also supports sendBeacon when a tab closes. No upstream URL or credentials
// are needed after the initial playlist request.
export async function POST(request) {
  const gateway = await hlsGateway(request);
  if (gateway) return gateway;
  const params = new URL(request.url).searchParams;
  const id = params.get('sid') || '';
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) return new Response('Invalid session', { status: 400 });
  if (params.get('close') === '1') {
    await releaseHlsSession(id);
    return new Response(null, { status: 204 });
  }
  try {
    touchHlsSession(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return new Response(error.message, { status: error.status || 502 });
  }
}

export async function DELETE(request) {
  const gateway = await hlsGateway(request);
  if (gateway) return gateway;
  const id = new URL(request.url).searchParams.get('sid') || '';
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) return new Response('Invalid session', { status: 400 });
  await releaseHlsSession(id);
  return new Response(null, { status: 204 });
}
