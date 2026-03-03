import { NextRequest, NextResponse } from 'next/server';

/**
 * Security-hardened proxy example for vinext on Cloudflare Workers.
 *
 * This proxy adds:
 * 1. Security response headers (OWASP recommended)
 * 2. Double-encoded path traversal protection
 *
 * See: https://owasp.org/www-project-secure-headers/
 */
export default function proxy(request: NextRequest) {
  // Block double-encoded path traversal attempts.
  // %252f = double-encoded '/', %2e%2e = encoded '..',  %5c = encoded '\'
  // These can bypass route matching when the server decodes at different stages.
  const rawUrl = request.url;
  if (/%25[0-9a-fA-F]{2}/.test(rawUrl) || /%5[cC]/.test(rawUrl)) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const response = NextResponse.next();

  // Prevent MIME-type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking — use 'SAMEORIGIN' if you embed your own pages in iframes
  response.headers.set('X-Frame-Options', 'DENY');

  // Control referrer information sent to other origins
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Restrict browser features — customize based on your app's needs
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );

  return response;
}

export const config = {
  matcher: [
    // Match all paths except static assets and vinext internals.
    // This explicit matcher ensures /api/* routes are also covered.
    '/((?!_vinext|_next/static|favicon\\.ico).*)',
  ],
};
