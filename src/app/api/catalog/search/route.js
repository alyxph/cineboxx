import { NextResponse } from 'next/server';
import { searchCatalog } from '@/lib/catalog';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');
    const page = Number(searchParams.get('page') || '1');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
      return NextResponse.json({ success: false, error: 'Nomor halaman tidak valid.' }, { status: 400 });
    }

    if (!q) {
      return NextResponse.json({ success: true, videos: [], page: 1 });
    }

    const data = await searchCatalog(q, page);
    return NextResponse.json({ success: true, ...data });
  } catch (error) {
    console.error('Error searching:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
