import { NextResponse } from 'next/server';
import { getMovieSource } from '@/lib/catalog';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelId = searchParams.get('model_id');
    const id = searchParams.get('id');
    const episodeId = searchParams.get('episode_id') || '';

    if (!modelId || !id) {
      return NextResponse.json({ success: false, error: 'model_id and id are required' }, { status: 400 });
    }

    const data = await getMovieSource(modelId, id, episodeId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching stream source:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
