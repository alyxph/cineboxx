import { NextResponse } from 'next/server';
import { getMovieDetail } from '@/lib/catalog';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelId = searchParams.get('model_id');
    const id = searchParams.get('id');

    if (!modelId || !id) {
      return NextResponse.json({ success: false, error: 'model_id and id are required' }, { status: 400 });
    }

    const detail = await getMovieDetail(modelId, id);
    return NextResponse.json({ success: true, data: detail });
  } catch (error) {
    console.error('Error fetching detail:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
