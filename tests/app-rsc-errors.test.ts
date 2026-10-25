import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRscOnErrorHandler,
  errorDigest,
  getDigestForWellKnownError,
  PRODUCTION_SERVER_COMPONENTS_ERROR_MESSAGE,
  sanitizeErrorForClient,
} from "../packages/vinext/src/server/app-rsc-errors.js";

type DigestCarrier = Error & { digest: unknown };

function expectDigestError(value: unknown): DigestCarrier {
  if (!(value instanceof Error) || !("digest" in value)) {
    throw new Error("expected production sanitization to return a digest error");
  }
  return value;
}

function renderErrorContext(routePath: string) {
  return {
    routerKind: "App Router" as const,
    routePath,
    routeType: "render" as const,
    revalidateReason: undefined,
  };
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
    expect(digestError.message).toBe(PRODUCTION_SERVER_COMPONENTS_ERROR_MESSAGE);
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
      errorContext: renderErrorContext("/metadata"),
      nodeEnv: "production",
      reportRequestError,
      requestInfo: { path: "/metadata", method: "GET", headers: {} },
    });

    expect(onError(sanitized)).toBe(errorDigest("metadata secretoriginal stack"));
    expect(reportRequestError).toHaveBeenCalledOnce();
    expect(reportRequestError.mock.calls[0]?.[0]).toBe(original);
  });

  // Ported from Next.js: packages/next/src/server/app-render/create-error-handler.tsx
  it("digests a thrown string as is and other values as an Error, like Next.js", () => {
    expect(expectDigestError(sanitizeErrorForClient("boom", "production")).digest).toBe(
      errorDigest("boom"),
    );

    const sanitized = sanitizeErrorForClient({ message: "object detail" }, "production");
    expect(sanitized).toBeInstanceOf(Error);
    expect(expectDigestError(sanitized).digest).toMatch(/^\d+$/);
    expect(expectDigestError(sanitized).digest).not.toBe(errorDigest("[object Object]"));
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
      errorContext: renderErrorContext("/feed"),
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
      errorContext: renderErrorContext("/feed"),
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
      errorContext: renderErrorContext("/feed"),
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
        revalidateReason: undefined,
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

  // Ported from Next.js: packages/next/src/server/app-render/create-error-handler.tsx
  // It reports getProperError(thrownValue) and only hashes a thrown string.
  it.each([
    [{ message: "object detail" }, '{"message":"object detail"}'],
    [0, "0"],
    [undefined, "undefined"],
  ])("reports a thrown %j as an Error, like Next.js", (thrownValue, message) => {
    const reportRequestError = vi.fn();
    const onError = createRscOnErrorHandler({
      errorContext: renderErrorContext("/feed"),
      nodeEnv: "production",
      reportRequestError,
      requestInfo: { path: "/feed", method: "GET", headers: {} },
    });

    const digest = onError(thrownValue);
    expect(digest).toMatch(/^\d+$/);
    expect(reportRequestError).toHaveBeenCalledOnce();
    expect(reportRequestError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    // As in Next.js, the reported Error carries the digest the client receives.
    expect(reportRequestError.mock.calls[0]?.[0]).toMatchObject({ message, digest });
  });

  it.each(["plain", "digested", "frozen"])(
    "reports a production-sanitized %s error carrying the digest the client receives",
    (kind) => {
      const reportRequestError = vi.fn();
      const onError = createRscOnErrorHandler({
        errorContext: renderErrorContext("/feed"),
        nodeEnv: "production",
        reportRequestError,
        requestInfo: { path: "/feed", method: "GET", headers: {} },
      });
      const original = new Error("connect postgres://admin:s3cret@10.0.0.5:5432/prod failed");
      if (kind === "digested") Object.assign(original, { digest: "custom-digest" });
      if (kind === "frozen") Object.freeze(original);
      const sanitized = expectDigestError(sanitizeErrorForClient(original, "production"));

      expect(onError(sanitized)).toBe(sanitized.digest);
      expect(reportRequestError).toHaveBeenCalledOnce();
      expect(reportRequestError.mock.calls[0]?.[0]).toBe(original);
      if (kind === "frozen") {
        expect(original).not.toHaveProperty("digest");
      } else {
        expect(original).toHaveProperty("digest", sanitized.digest);
      }
    },
  );

  it("only hashes a thrown string, like Next.js", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reportRequestError = vi.fn();
      const onError = createRscOnErrorHandler({
        errorContext: renderErrorContext("/feed"),
        nodeEnv: "development",
        reportRequestError,
        requestInfo: { path: "/feed", method: "GET", headers: {} },
      });

      expect(onError("boom")).toBe(errorDigest("boom"));
      expect(onError(sanitizeErrorForClient("boom", "production"))).toBe(errorDigest("boom"));
      expect(reportRequestError).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
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
        errorContext: renderErrorContext("/feed"),
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

  it.each(["plain", "digested", "sanitized", "frozen"])(
    "logs the original %s error and route once during production prerender",
    (kind) => {
      vi.stubEnv("VINEXT_PRERENDER", "1");
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const onError = createRscOnErrorHandler({
          errorContext: renderErrorContext("/posts/[slug]"),
          nodeEnv: "production",
          reportRequestError() {},
          requestInfo: { path: "/posts/intro", method: "GET", headers: {} },
        });
        const original = new Error("Cloudflare bindings are unavailable");
        if (kind === "digested") Object.assign(original, { digest: "custom-digest" });
        if (kind === "frozen") Object.freeze(original);
        const error =
          kind === "sanitized" ? sanitizeErrorForClient(original, "production") : original;

        onError(error);
        onError(error);

        expect(consoleError).toHaveBeenCalledExactlyOnceWith(
          '[vinext] Error prerendering route "/posts/intro":',
          original,
        );
        // Terminal diagnostics must not alter production error sanitization.
        expect(expectDigestError(sanitizeErrorForClient(original, "production")).message).toBe(
          PRODUCTION_SERVER_COMPONENTS_ERROR_MESSAGE,
        );
      } finally {
        consoleError.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("keeps navigation, dynamic bailouts and aborts quiet during prerender", () => {
    vi.stubEnv("VINEXT_PRERENDER", "1");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reportRequestError = vi.fn();
      const onError = createRscOnErrorHandler({
        errorContext: renderErrorContext("/feed"),
        nodeEnv: "production",
        reportRequestError,
        requestInfo: { path: "/feed", method: "GET", headers: {} },
      });
      for (const digest of [
        "NEXT_NOT_FOUND",
        "NEXT_REDIRECT;push;%2Ffeed;307",
        "BAILOUT_TO_CLIENT_SIDE_RENDERING",
        "DYNAMIC_SERVER_USAGE",
      ]) {
        const error = Object.assign(new Error("control flow"), { digest });
        expect(onError(error)).toBe(digest);
        expect(onError(sanitizeErrorForClient(error, "production"))).toBe(digest);
      }
      for (const name of ["AbortError", "ResponseAborted"]) {
        const error = Object.assign(new Error("cancelled"), { name });
        expect(onError(error)).toBeUndefined();
        expect(onError(sanitizeErrorForClient(error, "production"))).toBeUndefined();
      }
      expect(reportRequestError).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      vi.unstubAllEnvs();
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
          errorContext: renderErrorContext("/feed"),
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
