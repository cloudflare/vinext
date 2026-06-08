import { draftMode } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Mirrors the upstream `app-middleware` fixture: mutate the *request* headers
 * so downstream handlers (including Pages Router `pages/api/*`) observe the
 * injected header, and enable draft mode on `?draft=true`. Regression coverage
 * for #1520.
 */
export async function middleware(request: NextRequest) {
  if (request.nextUrl.searchParams.get("draft")) {
    (await draftMode()).enable();
  }
  const headers = new Headers(request.headers);
  headers.set("x-from-middleware", "hello-from-middleware");
  return NextResponse.next({ request: { headers } });
}
