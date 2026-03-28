import { describe, expect, it } from "vite-plus/test";
import {
  getAppRouteHandlerRevalidateSeconds,
  hasAppRouteHandlerDefaultExport,
  resolveAppRouteHandlerMethod,
  resolveAppRouteHandlerSpecialError,
  shouldApplyAppRouteHandlerRevalidateHeader,
  shouldReadAppRouteHandlerCache,
  shouldWriteAppRouteHandlerCache,
} from "../packages/vinext/src/server/app-route-handler-policy.js";

describe("app route handler policy helpers", () => {
  it("extracts finite positive route handler revalidate values", () => {
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: 60 })).toBe(60);
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: 0 })).toBeNull();
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: Infinity })).toBeNull();
    expect(getAppRouteHandlerRevalidateSeconds({ revalidate: false })).toBeNull();
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
});
