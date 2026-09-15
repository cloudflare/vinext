import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  Sentry.captureException(new Error('route-handler-capture-exception'));
  return NextResponse.json({ message: 'Exception captured' });
}
