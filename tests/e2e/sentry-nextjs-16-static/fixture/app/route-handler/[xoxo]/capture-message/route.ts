import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  Sentry.captureMessage('route-handler-message');
  return NextResponse.json({ message: 'Message captured' });
}
