import { NextResponse } from 'next/server';
import { getSources } from '@/lib/catalog';

export async function GET() {
  try {
    const sources = await getSources();
    return NextResponse.json({ success: true, data: sources });
  } catch (error) {
    console.error('Error fetching sources:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
