import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRscOnErrorHandler,
  errorDigest,
  getDigestForWellKnownError,
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

  it("keeps an existing non-signal digest on the sanitized transport error", () => {
    const error = Object.assign(new Error("secret details"), { digest: "existing-digest" });

    const sanitized = sanitizeErrorForClient(error, "production");

    expect(sanitized).not.toBe(error);
    expect(expectDigestError(sanitized).digest).toBe("existing-digest");
  });

  it("reports the original server error when the client transport error is sanitized", () => {
    const original = new Error("metadata secret");
    original.stack = "original stack";
    const sanitized = sanitizeErrorForClient(original, "production");
    const reportRequestError = vi.fn();
    const onError = createRscOnErrorHandler({
      errorContext: { routerKind: "App Router", routePath: "/metadata", routeType: "render" },
      nodeEnv: "production",
      reportRequestError,
      requestInfo: { path: "/metadata", method: "GET", headers: {} },
    });

    expect(onError(sanitized)).toBe(errorDigest("metadata secretoriginal stack"));
    expect(reportRequestError).toHaveBeenCalledOnce();
    expect(reportRequestError.mock.calls[0]?.[0]).toBe(original);
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

  it("reports a digest-bearing non-signal error and preserves its digest", () => {
    const reportRequestError = vi.fn();
    const onError = createRscOnErrorHandler({
      errorContext: { routerKind: "App Router", routePath: "/feed", routeType: "render" },
      nodeEnv: "production",
      reportRequestError,
      requestInfo: { path: "/feed", method: "GET", headers: {} },
    });

    // An error pre-stamped with a non-signal digest (e.g. a hashed digest from
    // sanitizeErrorForClient, or one transported from a nested boundary) must
    // still reach instrumentation instead of being mistaken for a control-flow
    // signal — and its existing digest is returned as-is, not re-hashed.
    const error = Object.assign(new Error("boom"), { digest: "customdigest123" });

    expect(onError(error)).toBe("customdigest123");
    expect(reportRequestError).toHaveBeenCalledOnce();
    expect(reportRequestError.mock.calls[0]?.[0]).toBe(error);
  });

  it("short-circuits bailout-to-CSR and dynamic-server signals without reporting", () => {
    const reportRequestError = vi.fn();
    const onError = createRscOnErrorHandler({
      errorContext: { routerKind: "App Router", routePath: "/feed", routeType: "render" },
      nodeEnv: "production",
      reportRequestError,
      requestInfo: { path: "/feed", method: "GET", headers: {} },
    });

    expect(onError({ digest: "BAILOUT_TO_CLIENT_SIDE_RENDERING" })).toBe(
      "BAILOUT_TO_CLIENT_SIDE_RENDERING",
    );
    expect(onError({ digest: "DYNAMIC_SERVER_USAGE" })).toBe("DYNAMIC_SERVER_USAGE");
    expect(reportRequestError).not.toHaveBeenCalled();
  });

  it("classifies well-known signal digests but not arbitrary ones", () => {
    expect(getDigestForWellKnownError({ digest: "NEXT_NOT_FOUND" })).toBe("NEXT_NOT_FOUND");
    expect(getDigestForWellKnownError({ digest: "NEXT_REDIRECT;push;%2Fx;307" })).toBe(
      "NEXT_REDIRECT;push;%2Fx;307",
    );
    expect(getDigestForWellKnownError({ digest: "NEXT_HTTP_ERROR_FALLBACK;403" })).toBe(
      "NEXT_HTTP_ERROR_FALLBACK;403",
    );
    expect(getDigestForWellKnownError({ digest: "BAILOUT_TO_CLIENT_SIDE_RENDERING" })).toBe(
      "BAILOUT_TO_CLIENT_SIDE_RENDERING",
    );
    expect(getDigestForWellKnownError({ digest: "DYNAMIC_SERVER_USAGE" })).toBe(
      "DYNAMIC_SERVER_USAGE",
    );

    expect(getDigestForWellKnownError({ digest: "701844781" })).toBeUndefined();
    expect(getDigestForWellKnownError(new Error("no digest"))).toBeUndefined();
    expect(getDigestForWellKnownError(undefined)).toBeUndefined();
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
    expect(error).toMatchObject({ digest: errorDigest("render failedstack") });
  });

  it("stamps generic development RSC errors with the returned digest", () => {
    const onError = createRscOnErrorHandler({
      errorContext: null,
      nodeEnv: "development",
      reportRequestError() {},
      requestInfo: null,
    });
    const error = new Error("render failed");
    error.stack = "stack";

    expect(onError(error)).toBe(errorDigest("render failedstack"));
    expect(error).toMatchObject({ digest: errorDigest("render failedstack") });
  });

  it("returns a digest without masking frozen RSC errors", () => {
    const onError = createRscOnErrorHandler({
      errorContext: null,
      nodeEnv: "development",
      reportRequestError() {},
      requestInfo: null,
    });
    const error = new Error("render failed");
    error.stack = "stack";
    Object.freeze(error);

    expect(() => onError(error)).not.toThrow();
    expect(onError(error)).toBe(errorDigest("render failedstack"));
    expect(error).not.toHaveProperty("digest");
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

  it("logs generic render errors to the dev-server terminal even without instrumentation", () => {
    // Regression: `reportRequestError` is a no-op when no `onRequestError` hook
    // is registered, so a server render error was swallowed silently in the dev
    // server. Development must surface it on the terminal regardless.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onError = createRscOnErrorHandler({
        errorContext: null,
        nodeEnv: "development",
        reportRequestError() {},
        requestInfo: null,
      });
      const error = new Error("render failed");
      error.stack = "stack";

      onError(error);

      expect(consoleError).toHaveBeenCalledWith("[vinext] Server render error:", error);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not log generic render errors to the terminal in production", () => {
    // Production reports through `reportRequestError`; the transport error is
    // returned to the client and must not be double-surfaced on the terminal.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onError = createRscOnErrorHandler({
        errorContext: { routerKind: "App Router", routePath: "/feed", routeType: "render" },
        nodeEnv: "production",
        reportRequestError() {},
        requestInfo: { path: "/feed", method: "GET", headers: {} },
      });
      const error = new Error("render failed");
      error.stack = "stack";

      onError(error);

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not re-log a digest-bearing error as it bubbles through nested onError passes", () => {
    // The same error object reaches this handler on both the RSC and SSR/HTML
    // render passes; the first pass stamps a digest, so a digest-bearing error
    // must not be logged again (matching Next.js's silenceLog dedup).
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onError = createRscOnErrorHandler({
        errorContext: null,
        nodeEnv: "development",
        reportRequestError() {},
        requestInfo: null,
      });
      const error = Object.assign(new Error("boom"), { digest: "customdigest123" });

      onError(error);

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not double-log well-known navigation signals in development", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onError = createRscOnErrorHandler({
        errorContext: null,
        nodeEnv: "development",
        reportRequestError() {},
        requestInfo: null,
      });

      onError({ digest: "NEXT_NOT_FOUND" });
      onError({ digest: "BAILOUT_TO_CLIENT_SIDE_RENDERING" });

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(["AbortError", "ResponseAborted"])(
    "does not report or log expected %s cancellations",
    (name) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const reportRequestError = vi.fn();
        const onError = createRscOnErrorHandler({
          errorContext: { routerKind: "App Router", routePath: "/feed", routeType: "render" },
          nodeEnv: "development",
          reportRequestError,
          requestInfo: { path: "/feed", method: "GET", headers: {} },
        });
        const error = Object.assign(new Error("cancelled"), { name });

        expect(onError(error)).toBeUndefined();
        expect(reportRequestError).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    },
  );

  it("logs the original server error when a wrapped transport error reaches dev logging", () => {
    // In production `sanitizeErrorForClient` wraps the real error behind a
    // digest-only transport error keyed by ORIGINAL_SERVER_ERROR. If such a
    // wrapper (with no digest) reaches the dev logger, unwrap it so the terminal
    // shows the real error rather than the opaque transport message.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const onError = createRscOnErrorHandler({
        errorContext: null,
        nodeEnv: "development",
        reportRequestError() {},
        requestInfo: null,
      });
      const original = new Error("real cause");
      const wrapper = new Error("opaque transport");
      Object.defineProperty(wrapper, Symbol.for("vinext.originalServerError"), {
        enumerable: false,
        value: original,
      });

      onError(wrapper);

      expect(consoleError).toHaveBeenCalledWith("[vinext] Server render error:", original);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("uses process.env.NODE_ENV when no explicit environment is provided", () => {
    vi.stubEnv("NODE_ENV", "production");

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
      vi.unstubAllEnvs();
    }
  });
});
