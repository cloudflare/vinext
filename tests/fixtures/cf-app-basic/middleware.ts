import { draftMode } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { runtimeCondition as workerFirstCondition } from "runtime-condition-library/worker-first";
import { runtimeCondition as workerdFirstCondition } from "runtime-condition-library/workerd-first";

/**
 * Mirrors the upstream `app-middleware` fixture: mutate the *request* headers
 * so downstream handlers (including Pages Router `pages/api/*`) observe the
 * injected header, and enable draft mode on `?draft=true`. Regression coverage
 * for #1520.
 */
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/%61dmin") {
    return NextResponse.rewrite(new URL("/admin", request.url));
  }
  if (request.nextUrl.pathname.startsWith("/encoded-parity/rewrite/")) {
    const target = request.nextUrl.clone();
    target.pathname = request.nextUrl.pathname.replace(
      "/encoded-parity/rewrite/",
      "/encoded-parity/page/",
    );
    return NextResponse.rewrite(target);
  }
  if (request.nextUrl.searchParams.get("draft")) {
    (await draftMode()).enable();
  }
  const headers = new Headers(request.headers);
  headers.set("x-from-middleware", "hello-from-middleware");
  headers.set("x-middleware-worker-first-condition", workerFirstCondition);
  headers.set("x-middleware-workerd-first-condition", workerdFirstCondition);
  return NextResponse.next({ request: { headers } });
}
