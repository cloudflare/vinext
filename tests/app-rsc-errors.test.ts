import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRscOnErrorHandler,
  errorDigest,
  sanitizeErrorForClient,
} from "../packages/vinext/src/server/app-rsc-errors.js";

type DigestCarrier = Error & { digest: unknown };

function expectDigestError(value: unknown): DigestCarrier {
  if (!(value instanceof Error) || !("digest" in value)) {
    throw new Error("expected production sanitization to return a digest error");
  }
  return value;
}

describe("app RSC error primitives", () => {
  it("uses the same stable digest hash shape as Next.js stringHash", () => {
    expect(errorDigest("message-stack")).toBe("701844781");
  });

  it("passes through navigation digest errors during sanitization", () => {
    const redirectError = Object.assign(new Error("redirect"), {
      digest: "NEXT_REDIRECT;push;%2Fdashboard;307",
    });

    expect(sanitizeErrorForClient(redirectError, "production")).toBe(redirectError);
  });

  it("returns the original error outside production", () => {
    const error = new Error("debuggable");

    expect(sanitizeErrorForClient(error, "development")).toBe(error);
  });

  it("replaces generic production errors with a digest-only error", () => {
    const error = new Error("secret details");
    error.stack = "stack";

    const sanitized = sanitizeErrorForClient(error, "production");
    const digestError = expectDigestError(sanitized);

    expect(sanitized).not.toBe(error);
    expect(digestError.message).toContain("omitted in production");
    expect(digestError.digest).toBe(errorDigest("secret detailsstack"));
  });

  it("preserves the previous String(error) digest input for non-Error values", () => {
    const thrownValue = { message: "object detail" };

    const sanitized = sanitizeErrorForClient(thrownValue, "production");

    expect(sanitized).toBeInstanceOf(Error);
    expect(expectDigestError(sanitized).digest).toBe(errorDigest("[object Object]"));
  });

  it("returns existing digest strings from the RSC onError path", () => {
    const onError = createRscOnErrorHandler({
      errorContext: null,
      nodeEnv: "production",
      reportRequestError() {},
      requestInfo: null,
    });

    expect(onError({ digest: "NEXT_NOT_FOUND" })).toBe("NEXT_NOT_FOUND");
  });

  it("reports generic RSC render errors before returning a production digest", () => {
    const reportRequestError = vi.fn();
    const onError = createRscOnErrorHandler({
      errorContext: { routerKind: "App Router", routePath: "/feed", routeType: "render" },
      nodeEnv: "production",
      reportRequestError,
      requestInfo: { path: "/feed", method: "GET", headers: {} },
    });

    const error = new Error("render failed");
    error.stack = "stack";

    expect(onError(error)).toBe(errorDigest("render failedstack"));
    expect(reportRequestError).toHaveBeenCalledOnce();
    expect(reportRequestError).toHaveBeenCalledWith(
      error,
      {
        path: "/feed",
        method: "GET",
        headers: {},
      },
      {
        routerKind: "App Router",
        routePath: "/feed",
        routeType: "render",
      },
    );
  });

  it("reports non-Error thrown values with the previous String(error) message", () => {
    const reportRequestError = vi.fn();
    const onError = createRscOnErrorHandler({
      errorContext: { routerKind: "App Router", routePath: "/feed", routeType: "render" },
      nodeEnv: "production",
      reportRequestError,
      requestInfo: { path: "/feed", method: "GET", headers: {} },
    });

    const thrownValue = { message: "object detail" };

    expect(onError(thrownValue)).toBe(errorDigest("[object Object]"));
    expect(reportRequestError).toHaveBeenCalledOnce();
    expect(reportRequestError.mock.calls[0]?.[0]).toMatchObject({
      message: "[object Object]",
    });
  });

  it("uses process.env.NODE_ENV when no explicit environment is provided", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const onError = createRscOnErrorHandler({
        errorContext: null,
        reportRequestError() {},
        requestInfo: null,
      });
      const error = new Error("from env");
      error.stack = "";

      expect(onError(error)).toBe(errorDigest("from env"));
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
