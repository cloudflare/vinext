import { describe, expect, it } from "vite-plus/test";
import type { CachedRouteValue } from "../packages/vinext/src/shims/cache.js";
import {
  applyRouteHandlerMiddlewareContext,
  applyRouteHandlerRevalidateHeader,
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
      isHead: false,
      revalidateSeconds: 60,
    });
    expect(hit.headers.get("x-vinext-cache")).toBe("HIT");
    expect(hit.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
    await expect(hit.text()).resolves.toBe("from-cache");

    const staleHead = buildRouteHandlerCachedResponse(cachedValue, {
      cacheState: "STALE",
      isHead: true,
      revalidateSeconds: 60,
    });
    expect(staleHead.headers.get("x-vinext-cache")).toBe("STALE");
    expect(staleHead.headers.get("cache-control")).toBe("s-maxage=0, stale-while-revalidate");
    await expect(staleHead.text()).resolves.toBe("");
  });

  it("serializes APP_ROUTE cache values without cache bookkeeping headers", async () => {
    const response = new Response("cache me", {
      status: 201,
      headers: {
        "content-type": "text/plain",
        "cache-control": "s-maxage=60, stale-while-revalidate",
        "x-vinext-cache": "MISS",
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

  it("applies revalidate and MISS headers separately", () => {
    const response = new Response("hello");

    applyRouteHandlerRevalidateHeader(response, 30);
    markRouteHandlerCacheMiss(response);

    expect(response.headers.get("cache-control")).toBe("s-maxage=30, stale-while-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
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
