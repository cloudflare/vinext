import { getDefaultIsolationScope } from '@sentry/core';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function proxy(request: NextRequest) {
  Sentry.setTag('my-isolated-tag', true);
  Sentry.setTag('my-global-scope-isolated-tag', getDefaultIsolationScope().getScopeData().tags['my-isolated-tag']); // We set this tag to be able to assert that the previously set tag has not leaked into the global isolation scope

  if (request.headers.has('x-should-throw')) {
    throw new Error('Middleware Error');
  }

  if (request.headers.has('x-should-make-request')) {
    await fetch('http://localhost:3030/');
  }

  return NextResponse.next();
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: ['/api/endpoint-behind-middleware', '/api/endpoint-behind-faulty-middleware'],
};
