import { describe, expect, it } from "vite-plus/test";
import type { CachedRouteValue } from "../packages/vinext/src/shims/cache.js";
import {
  applyRouteHandlerMiddlewareContext,
  applyRouteHandlerRevalidateHeader,
  assertSupportedAppRouteHandlerResponse,
  buildAppRouteCacheValue,
  buildRouteHandlerCachedResponse,
  finalizeRouteHandlerResponse,
  markRouteHandlerCacheMiss,
} from "../packages/vinext/src/server/app-route-handler-response.js";

function buildCachedRouteValue(
  body: string,
  headers: Record<string, string> = {},
): CachedRouteValue {
  return {
    kind: "APP_ROUTE",
    body: new TextEncoder().encode(body).buffer,
    status: 200,
    headers,
  };
}

describe("app route handler response helpers", () => {
  it("returns the original response when no middleware context exists", () => {
    const response = new Response("hello");

    expect(
      applyRouteHandlerMiddlewareContext(response, {
        headers: null,
        status: null,
      }),
    ).toBe(response);
  });

  it("overrides singular headers and status with middleware values", async () => {
    const response = new Response("hello", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "cache-control": "s-maxage=60, stale-while-revalidate",
        "x-response": "app",
      },
    });

    const result = applyRouteHandlerMiddlewareContext(response, {
      headers: new Headers([
        ["cache-control", "private, max-age=5"],
        ["x-middleware", "mw"],
        ["x-response", "middleware-copy"],
      ]),
      status: 202,
    });

    expect(result.status).toBe(202);
    expect(result.headers.get("content-type")).toBe("text/plain");
    expect(result.headers.get("cache-control")).toBe("private, max-age=5");
    expect(result.headers.get("x-response")).toBe("middleware-copy");
    expect(result.headers.get("x-middleware")).toBe("mw");
    await expect(result.text()).resolves.toBe("hello");
  });

  it("appends additive middleware headers for Set-Cookie and Vary", async () => {
    const response = new Response("hello", {
      status: 200,
      headers: [
        ["vary", "RSC, Accept"],
        ["set-cookie", "existing=1; Path=/"],
      ],
    });

    const middlewareHeaders = new Headers();
    middlewareHeaders.append("vary", "Next-Router-State-Tree");
    middlewareHeaders.append("set-cookie", "mw=1; Path=/");
    middlewareHeaders.append("set-cookie", "mw=2; Path=/; HttpOnly");

    const result = applyRouteHandlerMiddlewareContext(response, {
      headers: middlewareHeaders,
      status: null,
    });

    expect(result.headers.get("vary")).toBe("RSC, Accept, Next-Router-State-Tree");
    expect(result.headers.getSetCookie()).toEqual([
      "existing=1; Path=/",
      "mw=1; Path=/",
      "mw=2; Path=/; HttpOnly",
    ]);
    await expect(result.text()).resolves.toBe("hello");
  });

  it("builds cached HIT and STALE route handler responses", async () => {
    const cachedValue = buildCachedRouteValue("from-cache", {
      "content-type": "text/plain",
    });

    const hit = buildRouteHandlerCachedResponse(cachedValue, {
      cacheState: "HIT",
      expireSeconds: 300,
      isHead: false,
      revalidateSeconds: 60,
    });
    expect(hit.headers.get("x-vinext-cache")).toBe("HIT");
    expect(hit.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
    await expect(hit.text()).resolves.toBe("from-cache");

    const staleHead = buildRouteHandlerCachedResponse(cachedValue, {
      cacheState: "STALE",
      expireSeconds: 300,
      isHead: true,
      revalidateSeconds: 60,
    });
    expect(staleHead.headers.get("x-vinext-cache")).toBe("STALE");
    expect(staleHead.headers.get("cache-control")).toBe("s-maxage=0, stale-while-revalidate");
    await expect(staleHead.text()).resolves.toBe("");
  });

  it("prefers stored cache-control metadata over caller defaults", () => {
    const cachedValue = buildCachedRouteValue("from-cache");

    const response = buildRouteHandlerCachedResponse(cachedValue, {
      cacheControl: { revalidate: 15, expire: 300 },
      cacheState: "HIT",
      expireSeconds: 31_536_000,
      isHead: false,
      revalidateSeconds: 60,
    });

    expect(response.headers.get("cache-control")).toBe("s-maxage=15, stale-while-revalidate=285");
  });

  it("emits static cache-control for revalidateSeconds = Infinity (revalidate = false)", () => {
    const cachedValue = buildCachedRouteValue("from-cache");
    const response = buildRouteHandlerCachedResponse(cachedValue, {
      cacheState: "HIT",
      isHead: false,
      revalidateSeconds: Infinity,
    });
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    expect(response.headers.get("cache-control")).toBe("s-maxage=31536000, stale-while-revalidate");
  });

  it("applies revalidate header for Infinity as static cache-control", () => {
    const response = new Response("fresh");
    applyRouteHandlerRevalidateHeader(response, Infinity);
    expect(response.headers.get("cache-control")).toBe("s-maxage=31536000, stale-while-revalidate");
  });

  it("serializes APP_ROUTE cache values without cache bookkeeping headers", async () => {
    const response = new Response("cache me", {
      status: 201,
      headers: {
        "content-type": "text/plain",
        "cache-control": "s-maxage=60, stale-while-revalidate",
        "x-vinext-cache": "MISS",
        "x-middleware-set-cookie": "internal=1; Path=/",
        "x-extra": "kept",
      },
    });

    const value = await buildAppRouteCacheValue(response);

    expect(value.kind).toBe("APP_ROUTE");
    expect(value.status).toBe(201);
    expect(value.headers).toEqual({
      "content-type": "text/plain",
      "x-extra": "kept",
    });
    expect(new TextDecoder().decode(value.body)).toBe("cache me");
  });

  it("preserves multiple Set-Cookie headers when building cache value", async () => {
    const response = new Response("with cookies", {
      status: 200,
      headers: [
        ["content-type", "application/json"],
        ["set-cookie", "session=abc; Path=/; HttpOnly"],
        ["set-cookie", "theme=dark; Path=/"],
        ["set-cookie", "lang=en; Path=/; SameSite=Lax"],
      ],
    });

    const value = await buildAppRouteCacheValue(response);

    expect(value.headers["set-cookie"]).toEqual([
      "session=abc; Path=/; HttpOnly",
      "theme=dark; Path=/",
      "lang=en; Path=/; SameSite=Lax",
    ]);
    expect(value.headers["content-type"]).toBe("application/json");
  });

  it("omits set-cookie key when response has no Set-Cookie headers", async () => {
    const response = new Response("no cookies", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

    const value = await buildAppRouteCacheValue(response);

    expect(value.headers).toEqual({ "content-type": "text/plain" });
    expect(value.headers["set-cookie"]).toBeUndefined();
  });

  it("round-trips multiple Set-Cookie headers through cache store and restore", async () => {
    const original = new Response("round trip", {
      status: 200,
      headers: [
        ["content-type", "text/plain"],
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "b=2; Path=/"],
      ],
    });

    const cached = await buildAppRouteCacheValue(original);
    const restored = buildRouteHandlerCachedResponse(cached, {
      cacheState: "HIT",
      isHead: false,
      revalidateSeconds: 60,
    });

    expect(restored.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    await expect(restored.text()).resolves.toBe("round trip");
  });

  it("finalizes route handler responses with cookies and auto-head semantics", async () => {
    const response = new Response("body", {
      status: 202,
      statusText: "Accepted",
      headers: {
        "content-type": "text/plain",
      },
    });

    const result = finalizeRouteHandlerResponse(response, {
      pendingCookies: ["a=1; Path=/"],
      draftCookie: "draft=1; Path=/",
      isHead: true,
    });

    expect(result.status).toBe(202);
    expect(result.statusText).toBe("Accepted");
    expect(result.headers.getSetCookie?.()).toEqual(["a=1; Path=/", "draft=1; Path=/"]);
    await expect(result.text()).resolves.toBe("");
  });

  it("uses mutable cookies as fallbacks and keeps returned response cookies final", async () => {
    // Matches Next.js appendMutableCookies:
    // packages/next/src/server/web/spec-extension/adapters/request-cookies.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/web/spec-extension/adapters/request-cookies.ts
    const response = new Response("body", {
      headers: [
        ["Set-Cookie", "session=returned; Path=/; HttpOnly"],
        ["Set-Cookie", "response-only=1; Path=/"],
      ],
    });

    const result = finalizeRouteHandlerResponse(response, {
      pendingCookies: [
        "session=mutable; Path=/",
        "mutable-only=first; Path=/",
        "mutable-only=final; Path=/; Secure",
      ],
      draftCookie: null,
      isHead: false,
    });

    expect(result.headers.getSetCookie()).toEqual([
      "mutable-only=final; Path=/; Secure",
      "session=returned; Path=/; HttpOnly",
      "response-only=1; Path=/",
    ]);
    await expect(result.text()).resolves.toBe("body");
  });

  it("strips internal middleware headers from finalized route handler responses", async () => {
    const response = new Response("body", {
      headers: [
        ["set-cookie", "session=abc; Path=/"],
        ["x-middleware-set-cookie", "session=abc; Path=/"],
      ],
    });

    const result = finalizeRouteHandlerResponse(response, {
      pendingCookies: [],
      isHead: false,
    });

    expect(result.headers.get("x-middleware-set-cookie")).toBeNull();
    expect(result.headers.getSetCookie()).toEqual(["session=abc; Path=/"]);
    await expect(result.text()).resolves.toBe("body");
  });

  it("applies revalidate and MISS headers separately", () => {
    const response = new Response("hello");

    applyRouteHandlerRevalidateHeader(response, 30);
    markRouteHandlerCacheMiss(response);

    expect(response.headers.get("cache-control")).toBe("s-maxage=30, stale-while-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
  });

  it("only rejects the active x-middleware-next control signal", () => {
    expect(() =>
      assertSupportedAppRouteHandlerResponse(
        new Response(null, {
          headers: { "x-middleware-next": "0" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertSupportedAppRouteHandlerResponse(
        new Response(null, {
          headers: { "x-middleware-next": "true" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertSupportedAppRouteHandlerResponse(
        new Response(null, {
          headers: { "x-middleware-next": "1" },
        }),
      ),
    ).toThrow("NextResponse.next() was used in a app route handler");
  });

  it("emits a no-store Cache-Control for revalidate = 0 route handlers", () => {
    // A handler exporting `revalidate = 0` opts out of caching entirely.
    // The Cache-Control must tell browsers and CDNs never to store the
    // response. Emitting `s-maxage=0, stale-while-revalidate` (the SWR
    // template) would still permit intermediate caches to serve stale
    // copies, which is the exact opposite of the author's intent.
    // The exact string matches Next.js's own cache-control helper:
    // .nextjs-ref/packages/next/src/server/lib/cache-control.ts:29.
    const response = new Response("no cache me");

    applyRouteHandlerRevalidateHeader(response, 0);

    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });
});
