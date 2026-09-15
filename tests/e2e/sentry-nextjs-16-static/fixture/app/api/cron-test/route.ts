import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Simulate some work
  await new Promise(resolve => setTimeout(resolve, 100));
  return NextResponse.json({ message: 'Cron job executed successfully' });
}
