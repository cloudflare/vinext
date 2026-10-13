import {routing} from './i18n/routing';
import createMiddleware from 'next-intl/middleware';
import {NextRequest, NextResponse} from 'next/server';

export default async function middleware(request: NextRequest) {
  const handleI18nRouting = createMiddleware(routing);
  let response = handleI18nRouting(request);

  // Additional rewrite when v2 cookie is set
  if (response.ok) {
    // (not for errors or redirects)
    const [, locale, ...rest] = new URL(
      response.headers.get('x-middleware-rewrite') || request.url
    ).pathname.split('/');
    const pathname = '/' + rest.join('/');

    if (pathname === '/about' && request.cookies.get('v2')?.value === 'true') {
      response = NextResponse.rewrite(
        new URL(`/${locale}/about/v2`, request.url),
        {headers: response.headers}
      );
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Skip all paths that should not be internationalized
    '/((?!_next|.*/opengraph-image|.*\\..*).*)',

    // Necessary for base path to work
    '/'
  ]
};
