import { describe, expect, it } from "vite-plus/test";
import { executeMiddleware } from "../packages/vinext/src/server/middleware-runtime.js";
import { NextResponse } from "../packages/vinext/src/shims/server.js";

// ---------------------------------------------------------------------------
// Regression for issue #1332 sub-problem 1: middleware redirect Location
// headers must honour `trailingSlash` from next.config.js.
//
// When a middleware does `NextResponse.redirect(request.nextUrl)` or
// `NextResponse.redirect(new URL('/x', req.url))`, the Location header should
// reflect the user's trailingSlash policy. Mirrors Next.js behaviour where
// NextURL.href is formatted via formatNextPathnameInfo at stringification time.
// ---------------------------------------------------------------------------

describe("executeMiddleware propagates trailingSlash to NextURL", () => {
  it("emits Location with trailing slash when middleware redirects via request.nextUrl (trailingSlash: true)", async () => {
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: { nextUrl: { clone(): unknown } }) => {
          // Mirrors the Next.js fixture in test/e2e/middleware-trailing-slash:
          // mutate the URL and redirect to it.
          const url = (request.nextUrl as unknown as URL & { clone(): URL }).clone();
          url.pathname = "/somewhere";
          return NextResponse.redirect(url as unknown as URL);
        },
      },
      request: new Request("http://localhost/redirect-to-somewhere/"),
      trailingSlash: true,
    });

    expect(result.continue).toBe(false);
    expect(result.redirectStatus).toBe(307);
    expect(result.redirectUrl).not.toBeUndefined();
    expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe("/somewhere/");
  });

  it("emits Location without trailing slash when trailingSlash: false", async () => {
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: { nextUrl: { clone(): unknown } }) => {
          const url = (request.nextUrl as unknown as URL & { clone(): URL }).clone();
          url.pathname = "/somewhere/";
          return NextResponse.redirect(url as unknown as URL);
        },
      },
      request: new Request("http://localhost/redirect-to-somewhere"),
      trailingSlash: false,
    });

    expect(result.continue).toBe(false);
    expect(result.redirectUrl).not.toBeUndefined();
    expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe("/somewhere");
  });

  it("does not touch the root path regardless of trailingSlash", async () => {
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: { nextUrl: { clone(): unknown } }) => {
          const url = (request.nextUrl as unknown as URL & { clone(): URL }).clone();
          url.pathname = "/";
          return NextResponse.redirect(url as unknown as URL);
        },
      },
      request: new Request("http://localhost/somewhere"),
      trailingSlash: true,
    });

    expect(result.redirectUrl).not.toBeUndefined();
    expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe("/");
  });

  it("preserves search params when applying trailingSlash to redirect Location", async () => {
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: { nextUrl: { clone(): unknown } }) => {
          const url = (
            request.nextUrl as unknown as URL & {
              clone(): URL;
              searchParams: URLSearchParams;
            }
          ).clone();
          url.pathname = "/dest";
          url.searchParams.set("foo", "bar");
          return NextResponse.redirect(url as unknown as URL);
        },
      },
      request: new Request("http://localhost/src"),
      trailingSlash: true,
    });

    expect(result.redirectUrl).not.toBeUndefined();
    const loc = new URL(result.redirectUrl!, "http://localhost");
    expect(loc.pathname).toBe("/dest/");
    expect(loc.searchParams.get("foo")).toBe("bar");
  });
});
