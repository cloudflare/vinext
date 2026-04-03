import { describe, expect, it } from "vite-plus/test";
import {
  buildAppPageHtmlResponse,
  buildAppPageRscResponse,
  mergeMiddlewareResponseHeaders,
  resolveAppPageHtmlResponsePolicy,
  resolveAppPageRscResponsePolicy,
} from "../packages/vinext/src/server/app-page-response.js";

function createBody(text: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("app page response helpers", () => {
  it("resolves RSC response policy for static and ISR responses", () => {
    expect(
      resolveAppPageRscResponsePolicy({
        dynamicUsedDuringBuild: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: true,
        isProduction: true,
        revalidateSeconds: null,
      }),
    ).toEqual({
      cacheControl: "s-maxage=31536000, stale-while-revalidate",
      cacheState: "STATIC",
    });

    expect(
      resolveAppPageRscResponsePolicy({
        dynamicUsedDuringBuild: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: false,
        isProduction: true,
        revalidateSeconds: 60,
      }),
    ).toEqual({
      cacheControl: "s-maxage=60, stale-while-revalidate",
      cacheState: "MISS",
    });
  });

  it("resolves RSC response policy for force-dynamic, infinity, and default cases", () => {
    expect(
      resolveAppPageRscResponsePolicy({
        dynamicUsedDuringBuild: false,
        isDynamicError: false,
        isForceDynamic: true,
        isForceStatic: false,
        isProduction: true,
        revalidateSeconds: 60,
      }),
    ).toEqual({
      cacheControl: "no-store, must-revalidate",
    });

    expect(
      resolveAppPageRscResponsePolicy({
        dynamicUsedDuringBuild: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: false,
        isProduction: true,
        revalidateSeconds: Infinity,
      }),
    ).toEqual({
      cacheControl: "s-maxage=31536000, stale-while-revalidate",
      cacheState: "STATIC",
    });

    expect(
      resolveAppPageRscResponsePolicy({
        dynamicUsedDuringBuild: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: false,
        isProduction: true,
        revalidateSeconds: null,
      }),
    ).toEqual({});
  });

  it("resolves RSC response policy as no-store when dynamic usage is detected during build", () => {
    expect(
      resolveAppPageRscResponsePolicy({
        dynamicUsedDuringBuild: true,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: false,
        isProduction: true,
        revalidateSeconds: 60,
      }),
    ).toEqual({
      cacheControl: "no-store, must-revalidate",
    });
  });

  it("resolves HTML response policy precedence", () => {
    expect(
      resolveAppPageHtmlResponsePolicy({
        dynamicUsedDuringRender: true,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: false,
        isProduction: true,
        revalidateSeconds: 60,
      }),
    ).toEqual({
      cacheControl: "no-store, must-revalidate",
      shouldWriteToCache: false,
    });

    expect(
      resolveAppPageHtmlResponsePolicy({
        dynamicUsedDuringRender: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: false,
        isProduction: false,
        revalidateSeconds: 60,
      }),
    ).toEqual({
      cacheControl: "s-maxage=60, stale-while-revalidate",
      cacheState: undefined,
      shouldWriteToCache: false,
    });

    expect(
      resolveAppPageHtmlResponsePolicy({
        dynamicUsedDuringRender: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: false,
        isProduction: true,
        revalidateSeconds: Infinity,
      }),
    ).toEqual({
      cacheControl: "s-maxage=31536000, stale-while-revalidate",
      cacheState: "STATIC",
      shouldWriteToCache: false,
    });
  });

  it("resolves HTML response policy when cache writes stay enabled", () => {
    expect(
      resolveAppPageHtmlResponsePolicy({
        dynamicUsedDuringRender: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: false,
        isProduction: true,
        revalidateSeconds: 60,
      }),
    ).toEqual({
      cacheControl: "s-maxage=60, stale-while-revalidate",
      cacheState: "MISS",
      shouldWriteToCache: true,
    });
  });

  it("treats force-static with explicit revalidate as ISR in both policy helpers", () => {
    expect(
      resolveAppPageRscResponsePolicy({
        dynamicUsedDuringBuild: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: true,
        isProduction: true,
        revalidateSeconds: 60,
      }),
    ).toEqual({
      cacheControl: "s-maxage=60, stale-while-revalidate",
      cacheState: "MISS",
    });

    expect(
      resolveAppPageHtmlResponsePolicy({
        dynamicUsedDuringRender: false,
        isDynamicError: false,
        isForceDynamic: false,
        isForceStatic: true,
        isProduction: true,
        revalidateSeconds: 60,
      }),
    ).toEqual({
      cacheControl: "s-maxage=60, stale-while-revalidate",
      cacheState: "MISS",
      shouldWriteToCache: true,
    });
  });

  it("builds RSC responses with params, middleware headers, and timing", async () => {
    const middlewareHeaders = new Headers();
    middlewareHeaders.set("cache-control", "private, max-age=5");
    middlewareHeaders.append("set-cookie", "session=abc; Path=/");
    middlewareHeaders.append("vary", "Next-Router-State-Tree");

    const response = buildAppPageRscResponse(createBody("flight"), {
      middlewareContext: {
        headers: middlewareHeaders,
        status: 202,
      },
      params: { slug: "test" },
      policy: {
        cacheControl: "s-maxage=60, stale-while-revalidate",
        cacheState: "MISS",
      },
      timing: {
        compileEnd: 15,
        handlerStart: 10,
        responseKind: "rsc",
      },
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("text/x-component; charset=utf-8");
    expect(response.headers.get("x-vinext-params")).toBe(encodeURIComponent('{"slug":"test"}'));
    expect(response.headers.get("cache-control")).toBe("private, max-age=5");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    expect(response.headers.get("vary")).toBe("RSC, Accept, Next-Router-State-Tree");
    expect(response.headers.get("x-vinext-timing")).toBe("10,5,-1");
    await expect(response.text()).resolves.toBe("flight");
  });

  it("percent-encodes X-Vinext-Params so non-ASCII characters survive the ByteString header constraint (issue #676)", () => {
    // HTTP headers are ByteStrings: each character value must be <= 255.
    // JSON.stringify preserves non-ASCII characters verbatim (e.g. Korean 완 = U+C644 = 50756),
    // which causes Headers.set() to throw a TypeError in compliant runtimes.
    // The fix: encodeURIComponent the JSON before setting the header.
    const koreanSlug = "useState-완전정복";
    const response = buildAppPageRscResponse(createBody("flight"), {
      middlewareContext: { headers: new Headers(), status: 200 },
      params: { slug: [koreanSlug] },
      policy: {},
      timing: { handlerStart: 0, responseKind: "rsc" },
    });

    const rawHeader = response.headers.get("x-vinext-params")!;
    // Header value must be ASCII-safe (all byte values <= 127 after encoding)
    expect(Array.from(rawHeader).every((c) => c.charCodeAt(0) <= 127)).toBe(true);
    // Decoding must round-trip back to the original params
    expect(JSON.parse(decodeURIComponent(rawHeader))).toEqual({ slug: [koreanSlug] });
  });

  it("builds HTML responses with draft cookies, preload links, middleware, and timing", async () => {
    const middlewareHeaders = new Headers();
    middlewareHeaders.append("set-cookie", "mw=1; Path=/");
    middlewareHeaders.append("x-extra", "present");

    const response = buildAppPageHtmlResponse(createBody("<h1>page</h1>"), {
      draftCookie: "__prerender_bypass=token; Path=/",
      fontLinkHeader: "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
      middlewareContext: {
        headers: middlewareHeaders,
        status: 203,
      },
      policy: {
        cacheControl: "s-maxage=31536000, stale-while-revalidate",
        cacheState: "STATIC",
      },
      timing: {
        compileEnd: 12,
        handlerStart: 10,
        renderEnd: 20,
        responseKind: "html",
      },
    });

    expect(response.status).toBe(203);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("s-maxage=31536000, stale-while-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBe("STATIC");
    expect(response.headers.get("link")).toBe(
      "</font.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    );
    expect(response.headers.get("x-extra")).toBe("present");
    expect(response.headers.get("x-vinext-timing")).toBe("10,2,8");

    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toContain("__prerender_bypass=token; Path=/");
    expect(setCookies).toContain("mw=1; Path=/");
    await expect(response.text()).resolves.toBe("<h1>page</h1>");
  });
});

describe("mergeMiddlewareResponseHeaders", () => {
  it("is a no-op when middleware headers are null", () => {
    const target = new Headers({ "Content-Type": "text/plain" });
    mergeMiddlewareResponseHeaders(target, null);
    expect(target.get("Content-Type")).toBe("text/plain");
    expect([...target].length).toBe(1);
  });

  it("sets singular headers via set(), overriding existing values", () => {
    const target = new Headers({ "Cache-Control": "no-store", "X-Custom": "original" });
    const mwHeaders = new Headers();
    mwHeaders.set("Cache-Control", "private, max-age=5");
    mwHeaders.set("X-Custom", "from-middleware");

    mergeMiddlewareResponseHeaders(target, mwHeaders);

    expect(target.get("Cache-Control")).toBe("private, max-age=5");
    expect(target.get("X-Custom")).toBe("from-middleware");
  });

  it("appends Set-Cookie headers instead of overriding", () => {
    const target = new Headers();
    target.append("Set-Cookie", "existing=1; Path=/");
    const mwHeaders = new Headers();
    mwHeaders.append("Set-Cookie", "mw-session=abc; Path=/");

    mergeMiddlewareResponseHeaders(target, mwHeaders);

    const cookies = target.getSetCookie();
    expect(cookies).toContain("existing=1; Path=/");
    expect(cookies).toContain("mw-session=abc; Path=/");
  });

  it("appends Vary headers instead of overriding", () => {
    const target = new Headers({ Vary: "RSC, Accept" });
    const mwHeaders = new Headers();
    mwHeaders.set("Vary", "Next-Router-State-Tree");

    mergeMiddlewareResponseHeaders(target, mwHeaders);

    expect(target.get("Vary")).toBe("RSC, Accept, Next-Router-State-Tree");
  });
});
