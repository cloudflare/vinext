import { describe, expect, it, afterEach } from "vite-plus/test";
import { buildPostMwRequestContext } from "../packages/vinext/src/server/app-post-middleware-context.js";
import { setHeadersContext } from "../packages/vinext/src/shims/headers.js";

function makeRequest(
  url = "https://example.com/test?q=1",
  headers?: Record<string, string>,
): Request {
  return new Request(url, { headers: new Headers(headers) });
}

describe("buildPostMwRequestContext", () => {
  afterEach(() => {
    setHeadersContext(null);
  });

  it("returns the same shape as requestContextFromRequest when middleware did not run", () => {
    setHeadersContext(null);
    const req = makeRequest("https://example.com/path?x=1", {
      host: "example.com",
      cookie: "session=abc",
    });
    const ctx = buildPostMwRequestContext(req);

    // Contract: result must satisfy the RequestContext shape consumed by
    // config-matchers — headers, cookies, query, host — all present.
    expect(ctx.headers).toBeInstanceOf(Headers);
    expect(ctx.headers.get("host")).toBe("example.com");
    expect(typeof ctx.cookies).toBe("object");
    expect(ctx.cookies).not.toBeInstanceOf(Map);
    expect(ctx.cookies).toEqual({ session: "abc" });
    expect(ctx.query.get("x")).toBe("1");
    expect(ctx.host).toBe("example.com");
  });

  it("reads from the live ALS HeadersContext when middleware set request headers", () => {
    const mwHeaders = new Headers();
    mwHeaders.set("x-middleware-request-geo", "DE");
    mwHeaders.set("host", "mw.example.com");
    const mwCookies = new Map([
      ["token", "xyz"],
      ["lang", "en"],
    ]);

    setHeadersContext({ headers: mwHeaders, cookies: mwCookies });

    const req = makeRequest("https://original.example.com/path");
    const ctx = buildPostMwRequestContext(req);

    // Middleware headers take precedence over the physical request headers.
    expect(ctx.headers.get("x-middleware-request-geo")).toBe("DE");
    expect(ctx.host).toBe("mw.example.com");
    // Cookies come from the middleware context, not the request Cookie header.
    expect(ctx.cookies).toEqual({ token: "xyz", lang: "en" });
  });

  it("preserves query parameters from the original request URL", () => {
    setHeadersContext({
      headers: new Headers({ host: "x.com" }),
      cookies: new Map(),
    });
    const req = makeRequest("https://original.example.com/blog?page=2&sort=desc");
    const ctx = buildPostMwRequestContext(req);

    expect(ctx.query.get("page")).toBe("2");
    expect(ctx.query.get("sort")).toBe("desc");
  });

  it("handles an empty middleware cookie map without error", () => {
    setHeadersContext({
      headers: new Headers({ host: "x.com" }),
      cookies: new Map(),
    });
    const req = makeRequest();
    const ctx = buildPostMwRequestContext(req);

    expect(ctx.cookies).toEqual({});
  });

  it("normalizes the host from middleware headers, falling back to the request URL hostname", () => {
    // No Host header in middleware → normalizeHost falls back to url.hostname
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map(),
    });
    const req = makeRequest("https://host-from-url.example.com/page");
    const ctx = buildPostMwRequestContext(req);

    expect(ctx.host).toBe("host-from-url.example.com");
  });
});
