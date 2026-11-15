import { NextResponse } from 'next/server';
import { getVideos } from '@/lib/cineflow';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelId = searchParams.get('model_id');
    const categoryId = searchParams.get('category_id') || '';
    const page = Number(searchParams.get('page') || '1');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
      return NextResponse.json({ success: false, error: 'Nomor halaman tidak valid.' }, { status: 400 });
    }

    if (!modelId) {
      return NextResponse.json({ success: false, error: 'model_id is required' }, { status: 400 });
    }

    const data = await getVideos({ modelId, categoryId, page });
    return NextResponse.json({ success: true, ...data }, { headers: {
      'Cache-Control': 'no-store',
      ...(process.env.VERCEL_GIT_COMMIT_SHA ? { 'X-App-Revision': process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12) } : {}),
    } });
  } catch (error) {
    console.error('Error fetching videos:', error);
    return NextResponse.json({ success: false, error: error.message }, {
      status: Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
