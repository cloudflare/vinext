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

  // ---------------------------------------------------------------------------
  // Plain `new URL(...)` redirects — these bypass NextURL._applyTrailingSlash
  // so the fix in middleware-runtime.ts must apply normalizeTrailingSlashPathname
  // after relativizeLocation().
  // ---------------------------------------------------------------------------

  it("plain URL redirect gets trailing slash added when trailingSlash: true", async () => {
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: Request) => NextResponse.redirect(new URL("/somewhere", request.url)),
      },
      request: new Request("http://localhost/src"),
      trailingSlash: true,
    });

    expect(result.continue).toBe(false);
    expect(result.redirectUrl).not.toBeUndefined();
    expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe("/somewhere/");
  });

  it("plain URL redirect gets trailing slash removed when trailingSlash: false", async () => {
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: Request) =>
          NextResponse.redirect(new URL("/somewhere/", request.url)),
      },
      request: new Request("http://localhost/src"),
      trailingSlash: false,
    });

    expect(result.continue).toBe(false);
    expect(result.redirectUrl).not.toBeUndefined();
    expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe("/somewhere");
  });

  it("plain URL redirect to file path gets trailing slash added when trailingSlash: true", async () => {
    // Next.js uses formatNextPathnameInfo (plain add/strip, no file-extension
    // exemption) for middleware redirect Locations. /file.css should become
    // /file.css/ just like any other non-root path.
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: Request) => NextResponse.redirect(new URL("/file.css", request.url)),
      },
      request: new Request("http://localhost/src"),
      trailingSlash: true,
    });

    expect(result.continue).toBe(false);
    expect(result.redirectUrl).not.toBeUndefined();
    expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe("/file.css/");
  });

  it("NextURL redirect to file path gets trailing slash added (same result as plain URL)", async () => {
    // Lock in consistency: a NextURL-based redirect to /file.css should produce
    // the same Location as a plain-URL redirect to /file.css.
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: { nextUrl: { clone(): unknown } }) => {
          const url = (request.nextUrl as unknown as URL & { clone(): URL }).clone();
          url.pathname = "/file.css";
          return NextResponse.redirect(url as unknown as URL);
        },
      },
      request: new Request("http://localhost/src"),
      trailingSlash: true,
    });

    expect(result.continue).toBe(false);
    expect(result.redirectUrl).not.toBeUndefined();
    expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe("/file.css/");
  });
});

describe("executeMiddleware normalizes trailing slashes for matcher evaluation", () => {
  const protectedApiMiddleware = (observedPathnames: string[] = []) => ({
    config: { matcher: ["/api/admin"] },
    middleware: (request: { nextUrl: { pathname: string } }) => {
      observedPathnames.push(request.nextUrl.pathname);
      return new Response("unauthorized", { status: 401 });
    },
  });

  it("matches an exact API pathname when the request URL has a trailing slash", async () => {
    const result = await executeMiddleware({
      isProxy: false,
      module: protectedApiMiddleware(),
      request: new Request("http://localhost/api/admin/"),
    });

    expect(result.continue).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("matches an exact API pathname when an adapter provides a trailing-slash pathname", async () => {
    const observedPathnames: string[] = [];
    const result = await executeMiddleware({
      isProxy: false,
      module: protectedApiMiddleware(observedPathnames),
      normalizedPathname: "/api/admin/",
      request: new Request("http://localhost/api/admin/"),
    });

    expect(result.continue).toBe(false);
    expect(result.response?.status).toBe(401);
    expect(observedPathnames).toEqual(["/api/admin/"]);
  });

  it("matches a canonical API pathname when the matcher source has a trailing slash", async () => {
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        config: { matcher: ["/api/admin/"] },
        middleware: () => new Response("unauthorized", { status: 401 }),
      },
      request: new Request("http://localhost/api/admin"),
    });

    expect(result.continue).toBe(false);
    expect(result.response?.status).toBe(401);
  });

  it("preserves an escaped terminal slash matcher", async () => {
    const module = {
      config: { matcher: ["/api/admin\\/"] },
      middleware: () => new Response("unauthorized", { status: 401 }),
    };
    const matchingResult = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost/api/admin/"),
    });
    const nonMatchingResult = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost/api/admin"),
    });

    expect(matchingResult.continue).toBe(false);
    expect(matchingResult.response?.status).toBe(401);
    expect(nonMatchingResult).toEqual({ continue: true });
  });

  it("preserves a custom constraint that requires a terminal slash", async () => {
    const module = {
      config: { matcher: ["/:path(.*\\/)"] },
      middleware: () => new Response("unauthorized", { status: 401 }),
    };
    const matchingResult = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost/foo/"),
    });
    const nonMatchingResult = await executeMiddleware({
      isProxy: false,
      module,
      request: new Request("http://localhost/foo"),
    });

    expect(matchingResult.continue).toBe(false);
    expect(matchingResult.response?.status).toBe(401);
    expect(nonMatchingResult).toEqual({ continue: true });
  });
});
