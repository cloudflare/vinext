import { describe, expect, it } from "vite-plus/test";
import {
  getAppRouteHandlerRevalidateSeconds,
  hasAppRouteHandlerDefaultExport,
  hasNonStaticAppRouteHandlerMethods,
  isPossibleAppRouteActionRequest,
  resolveAppRouteHandlerMethod,
  resolveAppRouteHandlerStaticParamsEnforcement,
  resolveAppRouteHandlerSpecialError,
  shouldApplyAppRouteHandlerRevalidateHeader,
  shouldCompleteAppRouteHandlerResponse,
  shouldReadAppRouteHandlerCache,
  shouldWriteAppRouteHandlerCache,
} from "../packages/vinext/src/server/app-route-handler-policy.js";

describe("app route handler policy helpers", () => {
  // Next.js v16.2.7 enforces dynamicParams = false through the prerender
  // manifest, which a production build fills only for statically generated
  // routes: packages/next/src/build/index.ts
  it("enforces dynamicParams = false where Next.js lists the route as prerendered", () => {
    const GET = () => new Response("ok");
    const generateStaticParams = () => [{ slug: "one" }];
    const resolve = resolveAppRouteHandlerStaticParamsEnforcement;
    expect(resolve({ GET, generateStaticParams }, false)).toBe("skip");
    expect(resolve({ GET, dynamicParams: true, generateStaticParams }, true)).toBe("skip");

    const closed = { GET, dynamicParams: false, generateStaticParams };
    expect(resolve(closed, true)).toBe("enforce");
    expect(resolve({ ...closed, revalidate: 60 }, true)).toBe("enforce");

    for (const bailout of [{ dynamic: "force-dynamic" }, { revalidate: 0 }]) {
      expect(resolve({ ...closed, ...bailout }, true)).toBe("skip");
      // Dev checks every dynamicParams = false route with generateStaticParams.
      expect(resolve({ ...closed, ...bailout }, false)).toBe("enforce");
    }
    // These bail out only while a generated path prerenders.
    for (const methods of [{ POST: GET }, { OPTIONS: GET }]) {
      expect(resolve({ ...closed, ...methods }, true)).toBe("enforce-when-none-generated");
      expect(resolve({ ...closed, ...methods }, false)).toBe("enforce");
    }

    // Without generateStaticParams, only static production routes are listed.
    const noParams = { GET, dynamicParams: false };
    expect(resolve(noParams, true)).toBe("skip");
    expect(resolve(noParams, false)).toBe("skip");
    for (const dynamic of ["force-static", "error"]) {
      expect(resolve({ ...noParams, dynamic, POST: GET }, true)).toBe("enforce");
      expect(resolve({ ...noParams, dynamic }, false)).toBe("skip");
    }

    // Edge routes never prerender, so production has no entry for them.
    for (const runtime of ["edge", "experimental-edge"]) {
      expect(resolve({ ...closed, runtime }, true)).toBe("skip");
      expect(resolve({ ...noParams, dynamic: "force-static", runtime }, true)).toBe("skip");
    }
  });

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

  // Ported from Next.js:
  // packages/next/src/server/route-modules/app-route/helpers/is-static-gen-enabled.ts
  it("recognizes every App Route static-generation opt-in", () => {
    expect(getAppRouteHandlerRevalidateSeconds({ dynamic: "force-static" })).toBe(Infinity);
    expect(getAppRouteHandlerRevalidateSeconds({ dynamic: "error" })).toBe(Infinity);
    expect(
      getAppRouteHandlerRevalidateSeconds({
        generateStaticParams() {
          return [{ slug: "one" }];
        },
      }),
    ).toBe(Infinity);
    expect(getAppRouteHandlerRevalidateSeconds({ dynamic: "force-dynamic" })).toBeNull();
    expect(getAppRouteHandlerRevalidateSeconds({})).toBeNull();
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
      handlerSetCachePolicy: false,
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

  it("completes GET bodies when the CDN adapter requires response admission", () => {
    expect(
      shouldCompleteAppRouteHandlerResponse({
        dynamicConfig: "auto",
        dynamicUsedInHandler: false,
        handlerSetCachePolicy: false,
        isAutoHead: false,
        isProduction: true,
        method: "GET",
        revalidateSeconds: null,
        requiresCompletedResponseAdmission: true,
      }),
    ).toBe(true);
  });

  it("detects invalid default-export route handlers", () => {
    expect(hasAppRouteHandlerDefaultExport({ default() {} })).toBe(true);
    expect(hasAppRouteHandlerDefaultExport({ default: "nope" })).toBe(false);
    expect(hasAppRouteHandlerDefaultExport({ GET() {} })).toBe(false);
  });

  it("matches Next.js non-static Route Handler method detection", () => {
    expect(hasNonStaticAppRouteHandlerMethods({ GET() {} })).toBe(false);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const) {
      expect(hasNonStaticAppRouteHandlerMethods({ GET() {}, [method]() {} })).toBe(true);
    }
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
    // Infinite static entries still use the origin store, until invalidation.
    expect(shouldReadAppRouteHandlerCache({ ...base, revalidateSeconds: Infinity })).toBe(true);
  });

  it("determines when route handler cache headers and writes are allowed", () => {
    const base = {
      dynamicConfig: "auto",
      dynamicUsedInHandler: false,
      handlerSetCachePolicy: false,
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
      shouldApplyAppRouteHandlerRevalidateHeader({ ...base, handlerSetCachePolicy: true }),
    ).toBe(false);
    expect(shouldWriteAppRouteHandlerCache(base)).toBe(true);
    expect(shouldWriteAppRouteHandlerCache({ ...base, isProduction: false })).toBe(false);
    expect(shouldWriteAppRouteHandlerCache({ ...base, dynamicConfig: "force-dynamic" })).toBe(
      false,
    );
    expect(shouldWriteAppRouteHandlerCache({ ...base, revalidateSeconds: Infinity })).toBe(true);
    expect(shouldWriteAppRouteHandlerCache({ ...base, handlerSetCachePolicy: true })).toBe(true);
    // Infinity still emits a revalidate header for the static Cache-Control.
    expect(
      shouldApplyAppRouteHandlerRevalidateHeader({ ...base, revalidateSeconds: Infinity }),
    ).toBe(true);
  });

  it("completes explicit public policies even without a static segment config", () => {
    expect(
      shouldCompleteAppRouteHandlerResponse({
        dynamicUsedInHandler: false,
        handlerSetCachePolicy: true,
        hasExplicitCacheablePolicy: true,
        isAutoHead: false,
        isProduction: true,
        method: "GET",
        revalidateSeconds: null,
      }),
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
