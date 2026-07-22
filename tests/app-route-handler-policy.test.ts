import { describe, expect, it } from "vite-plus/test";
import {
  getAppRouteHandlerRevalidateSeconds,
  hasAppRouteHandlerDefaultExport,
  isPossibleAppRouteActionRequest,
  resolveAppRouteHandlerMethod,
  resolveAppRouteHandlerSpecialError,
  shouldApplyAppRouteHandlerRevalidateHeader,
  shouldReadAppRouteHandlerCache,
  shouldWriteAppRouteHandlerCache,
} from "../packages/vinext/src/server/app-route-handler-policy.js";

describe("app route handler policy helpers", () => {
  it("preserves revalidate = 0 as a distinct never-cache signal", () => {
    // revalidate = 0 must not collapse to null. Downstream header and cache
    // gates rely on 0 being observable to emit a no-store Cache-Control and
    // to skip ISR writes. Collapsing it to null would emit no Cache-Control
    // at all and let CDNs/browsers apply heuristic caching to a response
    // the author explicitly opted out of.
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: 60 })).toBe(60);
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: 0 })).toBe(0);
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: Infinity })).toBeNull();
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: Number.NaN })).toBeNull();
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: false })).toBe(Infinity);
  });

  it("treats revalidate = 0 as never-cache for route handler ISR read/write gates", () => {
    const readBase = {
      dynamicConfig: "auto",
      handlerFn() {},
      isAutoHead: false,
      isKnownDynamic: false,
      isProduction: true,
      method: "GET",
      revalidateSeconds: 0,
    };
    // A never-cache handler must not be served from ISR. Otherwise stale
    // entries written before the handler was marked never-cache would keep
    // replaying.
    expect(shouldReadAppRouteHandlerCache(readBase)).toBe(false);

    const writeBase = {
      dynamicConfig: "auto",
      dynamicUsedInHandler: false,
      handlerSetCacheControl: false,
      isAutoHead: false,
      isProduction: true,
      method: "GET",
      revalidateSeconds: 0,
    };
    // Writing a never-cache response to ISR would persist uncacheable
    // content under a key that later requests would try to serve.
    expect(shouldWriteAppRouteHandlerCache(writeBase)).toBe(false);

    // The framework still owns the Cache-Control header for revalidate = 0
    // unless the handler set its own. Gating this off would leave the
    // response with no Cache-Control and expose it to heuristic caching.
    expect(shouldApplyAppRouteHandlerRevalidateHeader(writeBase)).toBe(true);
  });

  it("detects invalid default-export route handlers", () => {
    expect(hasAppRouteHandlerDefaultExport({ default() {} })).toBe(true);
    expect(hasAppRouteHandlerDefaultExport({ default: "nope" })).toBe(false);
    expect(hasAppRouteHandlerDefaultExport({ GET() {} })).toBe(false);
  });

  it("resolves auto-options and auto-head route handler behavior", () => {
    const resolvedOptions = resolveAppRouteHandlerMethod(
      {
        GET() {},
        POST() {},
      },
      "OPTIONS",
    );

    expect(resolvedOptions.shouldAutoRespondToOptions).toBe(true);
    expect(resolvedOptions.allowHeaderForOptions).toBe("GET, HEAD, OPTIONS, POST");

    const resolvedHead = resolveAppRouteHandlerMethod(
      {
        GET() {
          return Response.json({ ok: true });
        },
      },
      "HEAD",
    );

    expect(resolvedHead.isAutoHead).toBe(true);
    expect(typeof resolvedHead.handlerFn).toBe("function");
  });

  it("determines when route handler ISR cache reads are allowed", () => {
    const base = {
      dynamicConfig: "auto",
      handlerFn() {},
      isAutoHead: false,
      isKnownDynamic: false,
      isProduction: true,
      method: "GET",
      revalidateSeconds: 60,
    };

    expect(shouldReadAppRouteHandlerCache(base)).toBe(true);
    expect(shouldReadAppRouteHandlerCache({ ...base, dynamicConfig: "force-dynamic" })).toBe(false);
    expect(shouldReadAppRouteHandlerCache({ ...base, isKnownDynamic: true })).toBe(false);
    expect(shouldReadAppRouteHandlerCache({ ...base, method: "POST" })).toBe(false);
    expect(shouldReadAppRouteHandlerCache({ ...base, method: "HEAD", isAutoHead: true })).toBe(
      true,
    );
    expect(shouldReadAppRouteHandlerCache({ ...base, method: "HEAD", isAutoHead: false })).toBe(
      false,
    );
    // Infinity (from revalidate = false) disables ISR reads because the
    // handler is fully static — the response is cached indefinitely with
    // no revalidation window. ISR reads would introduce KV cache churn for
    // a handler that never needs to revalidate.
    expect(shouldReadAppRouteHandlerCache({ ...base, revalidateSeconds: Infinity })).toBe(false);
  });

  it("determines when route handler cache headers and writes are allowed", () => {
    const base = {
      dynamicConfig: "auto",
      dynamicUsedInHandler: false,
      handlerSetCacheControl: false,
      isAutoHead: false,
      isProduction: true,
      method: "GET",
      revalidateSeconds: 60,
    };

    expect(shouldApplyAppRouteHandlerRevalidateHeader(base)).toBe(true);
    expect(
      shouldApplyAppRouteHandlerRevalidateHeader({ ...base, dynamicUsedInHandler: true }),
    ).toBe(false);
    expect(
      shouldApplyAppRouteHandlerRevalidateHeader({ ...base, handlerSetCacheControl: true }),
    ).toBe(false);
    expect(shouldWriteAppRouteHandlerCache(base)).toBe(true);
    expect(shouldWriteAppRouteHandlerCache({ ...base, isProduction: false })).toBe(false);
    expect(shouldWriteAppRouteHandlerCache({ ...base, dynamicConfig: "force-dynamic" })).toBe(
      false,
    );
    // Infinity (from revalidate = false) disables ISR writes because the
    // response is meant to be cached indefinitely — persisting to ISR
    // would introduce unnecessary KV writes and risk broken entries from
    // Infinity serialization.
    expect(shouldWriteAppRouteHandlerCache({ ...base, revalidateSeconds: Infinity })).toBe(false);
    // Infinity still emits a revalidate header for the static Cache-Control.
    expect(
      shouldApplyAppRouteHandlerRevalidateHeader({ ...base, revalidateSeconds: Infinity }),
    ).toBe(true);
  });

  it("maps special route handler digests to typed redirect and status results", () => {
    expect(
      resolveAppRouteHandlerSpecialError(
        { digest: "NEXT_REDIRECT;replace;%2Ftarget%3Fok%3D1;308" },
        "https://example.com/source",
      ),
    ).toEqual({
      kind: "redirect",
      location: "https://example.com/target?ok=1",
      statusCode: 308,
    });

    expect(
      resolveAppRouteHandlerSpecialError(
        { digest: "NEXT_REDIRECT;replace;%2Ftarget%3Fok%3D1;308" },
        "https://example.com/source",
        { isAction: true },
      ),
    ).toEqual({
      kind: "redirect",
      location: "https://example.com/target?ok=1",
      statusCode: 303,
    });

    expect(
      resolveAppRouteHandlerSpecialError(
        { digest: "NEXT_NOT_FOUND" },
        "https://example.com/source",
      ),
    ).toEqual({
      kind: "status",
      statusCode: 404,
    });

    expect(
      resolveAppRouteHandlerSpecialError(
        { digest: "NEXT_HTTP_ERROR_FALLBACK;401" },
        "https://example.com/source",
      ),
    ).toEqual({
      kind: "status",
      statusCode: 401,
    });

    expect(resolveAppRouteHandlerSpecialError(new Error("no digest"), "https://example.com")).toBe(
      null,
    );
  });

  it("classifies possible app-route action requests like Next.js", () => {
    expect(
      isPossibleAppRouteActionRequest(
        new Request("https://example.com/api", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
      ),
    ).toBe(true);
    expect(
      isPossibleAppRouteActionRequest(
        new Request("https://example.com/api", {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=test" },
        }),
      ),
    ).toBe(true);
    expect(
      isPossibleAppRouteActionRequest(
        new Request("https://example.com/api", {
          method: "POST",
          headers: { "x-rsc-action": "abc" },
        }),
      ),
    ).toBe(true);
    expect(
      isPossibleAppRouteActionRequest(
        new Request("https://example.com/api", {
          method: "POST",
          headers: { "next-action": "abc" },
        }),
      ),
    ).toBe(true);
    expect(
      isPossibleAppRouteActionRequest(
        new Request("https://example.com/api", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        }),
      ),
    ).toBe(false);
    expect(
      isPossibleAppRouteActionRequest(
        new Request("https://example.com/api", {
          method: "GET",
          headers: { "content-type": "multipart/form-data; boundary=test" },
        }),
      ),
    ).toBe(false);
    expect(
      isPossibleAppRouteActionRequest(
        new Request("https://example.com/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
        }),
      ),
    ).toBe(false);
  });
});
