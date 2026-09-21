import { describe, expect, it, vi } from "vite-plus/test";
import { createAppRscOnErrorHandler } from "../packages/vinext/src/server/app-rsc-error-handler.js";
import { errorDigest } from "../packages/vinext/src/server/app-rsc-errors.js";
import { getRevalidateSecret } from "../packages/vinext/src/server/revalidation-request.js";

function makeReq(
  url = "https://example.com/feed",
  method = "GET",
  headers?: Record<string, string>,
): Request {
  return new Request(url, { method, headers: new Headers(headers) });
}

describe("createAppRscOnErrorHandler", () => {
  it("returns a function that short-circuits on digest errors (NEXT_REDIRECT, NEXT_NOT_FOUND, etc.)", () => {
    const reportRequestError = vi.fn();
    const onError = createAppRscOnErrorHandler(reportRequestError, makeReq(), "/feed", "/feed");

    expect(onError({ digest: "NEXT_NOT_FOUND" })).toBe("NEXT_NOT_FOUND");
    expect(onError({ digest: "NEXT_REDIRECT;push;/login;307" })).toBe(
      "NEXT_REDIRECT;push;/login;307",
    );
    // Digest errors skip instrumentation.
    expect(reportRequestError).not.toHaveBeenCalled();
  });

  it("reports a digest-bearing non-signal error instead of treating it as a signal", () => {
    const reportRequestError = vi.fn();
    const onError = createAppRscOnErrorHandler(reportRequestError, makeReq(), "/feed", "/feed");

    const error = Object.assign(new Error("boom"), { digest: "customdigest123" });

    // The digest is preserved for the client, but the error is still reported.
    expect(onError(error)).toBe("customdigest123");
    expect(reportRequestError).toHaveBeenCalledOnce();
    expect(reportRequestError.mock.calls[0]?.[0]).toBe(error);
  });

  it("reports non-digest errors via reportRequestError with a derived requestInfo from the Web Request", () => {
    const reportRequestError = vi.fn();
    const req = makeReq("https://example.com/feed", "POST", {
      "user-agent": "test-agent",
      "x-forwarded-for": "10.0.0.1",
    });
    const onError = createAppRscOnErrorHandler(reportRequestError, req, "/feed", "/posts/[slug]");

    const error = new Error("render failed");
    onError(error);

    expect(reportRequestError).toHaveBeenCalledOnce();
    const [, requestInfo, errorContext] = reportRequestError.mock.calls[0];
    expect(requestInfo).toMatchObject({
      path: "/feed",
      method: "POST",
      headers: expect.objectContaining({
        "user-agent": "test-agent",
        "x-forwarded-for": "10.0.0.1",
      }),
    });
    expect(errorContext).toEqual({
      routerKind: "App Router",
      routePath: "/posts/[slug]",
      routeType: "render",
      renderSource: "react-server-components",
      revalidateReason: undefined,
    });
  });

  it("reports RSC payload and on-demand revalidation context", () => {
    const reportRequestError = vi.fn();
    const request = makeReq("https://example.com/feed.rsc", "GET", {
      RSC: "1",
      "x-prerender-revalidate": getRevalidateSecret(),
    });
    const onError = createAppRscOnErrorHandler(
      reportRequestError,
      request,
      "/feed",
      "/posts/[slug]",
      { revalidateReason: "stale" },
    );

    onError(new Error("payload failed"));

    expect(reportRequestError.mock.calls[0]?.[2]).toEqual({
      routerKind: "App Router",
      routePath: "/posts/[slug]",
      routeType: "render",
      renderSource: "react-server-components-payload",
      revalidateReason: "on-demand",
    });
  });

  it("applies action, SSR, and stale regeneration context overrides", () => {
    const reportRequestError = vi.fn();
    const onError = createAppRscOnErrorHandler(
      reportRequestError,
      makeReq("https://example.com/products/one", "POST"),
      "/products/one",
      "/products/[slug]",
      {
        renderSource: "server-rendering",
        revalidateReason: "stale",
        routeType: "action",
      },
    );

    const error = new Error("action SSR failed");
    error.stack = "action SSR stack";

    expect(onError(error)).toBe(errorDigest("action SSR failedaction SSR stack"));
    expect(error).not.toHaveProperty("digest");

    expect(reportRequestError.mock.calls[0]?.[2]).toEqual({
      routerKind: "App Router",
      routePath: "/products/[slug]",
      routeType: "action",
      renderSource: "server-rendering",
      revalidateReason: "stale",
    });
  });

  it("uses pathname as routePath when routePath is an empty string", () => {
    const reportRequestError = vi.fn();
    const onError = createAppRscOnErrorHandler(reportRequestError, makeReq(), "/dashboard", "");

    onError(new Error("oops"));

    expect(reportRequestError.mock.calls[0]?.[2].routePath).toBe("/dashboard");
  });

  it("produces a production digest for non-digest errors in production env", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const onError = createAppRscOnErrorHandler(() => {}, makeReq(), "/feed", "/feed");
      const error = new Error("secret");
      error.stack = "secret-stack";

      expect(onError(error)).toBe(errorDigest("secretsecret-stack"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returned handler preserves non-Error thrown values", () => {
    const reportRequestError = vi.fn();
    const onError = createAppRscOnErrorHandler(reportRequestError, makeReq(), "/feed", "/feed");

    onError("a plain string");

    expect(reportRequestError).toHaveBeenCalledOnce();
    const [error] = reportRequestError.mock.calls[0];
    expect(error).toBe("a plain string");
  });

  it("requestInfo headers are a plain Record, not Headers", () => {
    const reportRequestError = vi.fn();
    const req = makeReq("https://example.com/a", "GET", {
      "x-custom": "value",
    });
    const onError = createAppRscOnErrorHandler(reportRequestError, req, "/a", "/a");

    onError(new Error("boom"));

    const requestInfo = reportRequestError.mock.calls[0]?.[1];
    expect(requestInfo).toBeDefined();
    if (!requestInfo) throw new Error("expected requestInfo");
    const { headers } = requestInfo;
    expect(typeof headers).toBe("object");
    // Object.fromEntries returns a plain object, not an instance of Headers
    expect(headers).not.toBeInstanceOf(Headers);
    expect(headers).toEqual({ "x-custom": "value" });
  });
});
