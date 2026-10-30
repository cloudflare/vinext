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
  it("keeps an internal file request in its original non-trailing shape", async () => {
    let observedUrl: string | undefined;
    const result = await executeMiddleware({
      isProxy: false,
      module: {
        middleware: (request: Request) => {
          observedUrl = request.url;
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
      request: new Request(
        "http://localhost/_next/static/build-id/_devMiddlewareManifest.json?foo=1",
      ),
      trailingSlash: true,
    });

    expect(result.continue).toBe(true);
    expect(observedUrl).toBe(
      "http://localhost/_next/static/build-id/_devMiddlewareManifest.json?foo=1",
    );
  });

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

  // A source that keeps its terminal slash never matches the slash-stripped
  // pathname. Next.js first tests the pathname as requested, though, and ends
  // a request only that test accepts with an empty 200 without running
  // middleware.
  // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/next-server.ts
  const slashedSources = [
    { source: "/api/admin/", slashed: "/api/admin/" },
    { source: "/api/admin\\/", slashed: "/api/admin/" },
    { source: "/:path(.*\\/)", slashed: "/foo/" },
    { source: "/admin/(.*)", slashed: "/admin/" },
    { source: "/admin/:path*/", slashed: "/admin/users/" },
  ];

  it.each(slashedSources)(
    "does not match the unslashed spelling of $slashed for source $source",
    async ({ source, slashed }) => {
      const result = await executeMiddleware({
        isProxy: false,
        module: {
          config: { matcher: [source] },
          middleware: () => new Response("unauthorized", { status: 401 }),
        },
        request: new Request(`http://localhost${slashed.slice(0, -1)}`),
      });

      expect(result).toEqual({ continue: true });
    },
  );

  it.each(slashedSources)(
    "ends $slashed with an empty response for source $source without running middleware",
    async ({ source, slashed }) => {
      let invoked = false;
      let pathnameEligible = false;
      const result = await executeMiddleware({
        isProxy: false,
        module: {
          config: { matcher: [source] },
          middleware: () => {
            invoked = true;
            return new Response("unauthorized", { status: 401 });
          },
        },
        onPathMatch() {
          pathnameEligible = true;
        },
        request: new Request(`http://localhost${slashed}`),
        trailingSlash: true,
      });

      expect(invoked).toBe(false);
      expect(pathnameEligible).toBe(true);
      expect(result.continue).toBe(false);
      expect(result.response?.status).toBe(200);
      expect(await result.response?.text()).toBe("");
    },
  );

  it("does not run middleware when only the slash-stripped pathname matches", async () => {
    const run = (pathname: string) =>
      executeMiddleware({
        isProxy: false,
        module: {
          config: { matcher: ["/r1/((?!.*\\/$).*)"] },
          middleware: () => new Response("unauthorized", { status: 401 }),
        },
        request: new Request(`http://localhost${pathname}`),
        skipTrailingSlashRedirect: true,
      });

    expect(await run("/r1/x/")).toEqual({ continue: true });
    expect((await run("/r1/x")).response?.status).toBe(401);
  });

  it("applies has conditions to the as-requested matcher test", async () => {
    const run = (search: string) =>
      executeMiddleware({
        isProxy: false,
        module: {
          config: { matcher: [{ source: "/admin/", has: [{ type: "query", key: "x" }] }] },
          middleware: () => new Response("unauthorized", { status: 401 }),
        },
        request: new Request(`http://localhost/admin/${search}`),
        trailingSlash: true,
      });

    expect(await run("")).toEqual({ continue: true });
    expect((await run("?x=1")).response?.status).toBe(200);
  });

  it("strips basePath before the as-requested matcher test", async () => {
    const result = await executeMiddleware({
      basePath: "/docs",
      isProxy: false,
      module: {
        config: { matcher: ["/admin/"] },
        middleware: () => new Response("unauthorized", { status: 401 }),
      },
      request: new Request("http://localhost/docs/admin/"),
      trailingSlash: true,
    });

    expect(result.continue).toBe(false);
    expect(result.response?.status).toBe(200);
    expect(await result.response?.text()).toBe("");
  });
});

// With `skipTrailingSlashRedirect`, middleware sees requests in either slash
// form. Next.js's getNextPathnameInfo takes NextURL's slash from the pathname
// (the config only decides root), and the adapter formats a redirect Location
// from its own slash.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/get-next-pathname-info.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/adapter.ts
describe("executeMiddleware with skipTrailingSlashRedirect", () => {
  it.each([
    { trailingSlash: false, requestPath: "/another/" },
    { trailingSlash: true, requestPath: "/another" },
  ])(
    "keeps the request's own slash on nextUrl and request.url (trailingSlash: $trailingSlash)",
    async ({ trailingSlash, requestPath }) => {
      let observed: { pathname: string; href: string; url: string } | undefined;
      await executeMiddleware({
        isProxy: false,
        module: {
          middleware: (request: Request & { nextUrl: URL }) => {
            observed = {
              pathname: request.nextUrl.pathname,
              href: request.nextUrl.href,
              url: request.url,
            };
            return new Response(null, { headers: { "x-middleware-next": "1" } });
          },
        },
        request: new Request(`http://localhost${requestPath}?q=1`),
        skipTrailingSlashRedirect: true,
        trailingSlash,
      });

      expect(observed).toEqual({
        pathname: requestPath,
        href: `http://localhost${requestPath}?q=1`,
        url: `http://localhost${requestPath}?q=1`,
      });
    },
  );

  it.each([
    { trailingSlash: false, requestPath: "/src/", expected: "/somewhere/" },
    { trailingSlash: true, requestPath: "/src", expected: "/somewhere" },
  ])(
    "formats a request.nextUrl redirect from the request's slash (trailingSlash: $trailingSlash)",
    async ({ trailingSlash, requestPath, expected }) => {
      const result = await executeMiddleware({
        isProxy: false,
        module: {
          middleware: (request: { nextUrl: URL & { clone(): URL } }) => {
            const url = request.nextUrl.clone();
            url.pathname = "/somewhere";
            return NextResponse.redirect(url);
          },
        },
        request: new Request(`http://localhost${requestPath}`),
        skipTrailingSlashRedirect: true,
        trailingSlash,
      });

      expect(result.redirectStatus).toBe(307);
      expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe(expected);
    },
  );

  it.each([
    { trailingSlash: false, location: "/somewhere/" },
    { trailingSlash: true, location: "/somewhere" },
  ])(
    "keeps a plain URL redirect's own slash (trailingSlash: $trailingSlash)",
    async ({ trailingSlash, location }) => {
      const result = await executeMiddleware({
        isProxy: false,
        module: {
          middleware: (request: Request) => NextResponse.redirect(new URL(location, request.url)),
        },
        request: new Request("http://localhost/src"),
        skipTrailingSlashRedirect: true,
        trailingSlash,
      });

      expect(result.redirectStatus).toBe(307);
      expect(new URL(result.redirectUrl!, "http://localhost").pathname).toBe(location);
    },
  );
});
