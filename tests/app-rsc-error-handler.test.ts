import { describe, expect, it, vi } from "vite-plus/test";
import { createAppRscOnErrorHandler } from "../packages/vinext/src/server/app-rsc-error-handler.js";
import { errorDigest } from "../packages/vinext/src/server/app-rsc-errors.js";

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
    });
  });

  it("uses pathname as routePath when routePath is an empty string", () => {
    const reportRequestError = vi.fn();
    const onError = createAppRscOnErrorHandler(reportRequestError, makeReq(), "/dashboard", "");

    onError(new Error("oops"));

    expect(reportRequestError.mock.calls[0]?.[2].routePath).toBe("/dashboard");
  });

  it("produces a production digest for non-digest errors in production env", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const onError = createAppRscOnErrorHandler(() => {}, makeReq(), "/feed", "/feed");
      const error = new Error("secret");
      error.stack = "secret-stack";

      expect(onError(error)).toBe(errorDigest("secretsecret-stack"));
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("returned handler reports non-Error thrown values by wrapping them", () => {
    const reportRequestError = vi.fn();
    const onError = createAppRscOnErrorHandler(reportRequestError, makeReq(), "/feed", "/feed");

    onError("a plain string");

    expect(reportRequestError).toHaveBeenCalledOnce();
    const [error] = reportRequestError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("a plain string");
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
