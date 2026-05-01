/**
 * Error boundary unit tests.
 *
 * Tests the ErrorBoundary, NotFoundBoundary, ForbiddenBoundary, and
 * UnauthorizedBoundary components that handle error.tsx, not-found.tsx,
 * forbidden.tsx, and unauthorized.tsx rendering in the App Router.
 * Verifies correct digest handling, error propagation, and pathname reset.
 *
 * Ported from Next.js: test/e2e/app-dir/error-boundary/error-boundary.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/error-boundary/error-boundary.test.ts
 */
import { describe, it, expect, beforeAll, vi } from "vite-plus/test";

// Mock next/navigation since it's a virtual module provided by the vinext plugin.
// We only need usePathname for the NotFoundBoundary wrapper, not for the static
// getDerivedStateFromError methods we're testing.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));
// The error boundary is primarily a client-side component.
//
// Verified against Next.js source:
// - packages/next/src/client/components/error-boundary.tsx
// - packages/next/src/client/components/navigation.ts
//
// Next.js resets segment error boundaries on pathname changes using a
// previousPathname field, and usePathname() is pathname-only rather than
// query-aware. These tests lock our shim to that behavior.

type ErrorBoundaryInnerConstructor = {
  getDerivedStateFromError(error: unknown): Partial<{
    error: { thrownValue: unknown } | null;
    previousPathname: string;
  }>;
  getDerivedStateFromProps(
    props: {
      children: React.ReactNode;
      fallback: React.ComponentType<{ error: unknown; reset: () => void }>;
      pathname: string;
    },
    state: {
      error: { thrownValue: unknown } | null;
      previousPathname: string;
    },
  ): {
    error: { thrownValue: unknown } | null;
    previousPathname: string;
  } | null;
};

function isErrorBoundaryInnerConstructor(value: unknown): value is ErrorBoundaryInnerConstructor {
  return value !== null && typeof value === "function";
}

function createErrorWithDigest(message: string, digest: string) {
  return Object.assign(new Error(message), { digest });
}

// Test the digest detection patterns used by the boundaries
describe("ErrorBoundary digest patterns", () => {
  it("NEXT_NOT_FOUND digest matches legacy not-found pattern", () => {
    const error = createErrorWithDigest("Not Found", "NEXT_NOT_FOUND");
    expect(Reflect.get(error, "digest")).toBe("NEXT_NOT_FOUND");
  });

  it("NEXT_HTTP_ERROR_FALLBACK;404 matches new not-found pattern", () => {
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    const error = createErrorWithDigest("Not Found", digest);

    expect(Reflect.get(error, "digest")).toBe(digest);
    expect(digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")).toBe(true);
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("NEXT_HTTP_ERROR_FALLBACK;403 matches forbidden pattern", () => {
    const digest = "NEXT_HTTP_ERROR_FALLBACK;403";
    const error = createErrorWithDigest("Forbidden", digest);

    expect(Reflect.get(error, "digest")).toBe(digest);
    expect(digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")).toBe(true);
  });

  it("NEXT_HTTP_ERROR_FALLBACK;401 matches unauthorized pattern", () => {
    const digest = "NEXT_HTTP_ERROR_FALLBACK;401";
    const error = createErrorWithDigest("Unauthorized", digest);

    expect(Reflect.get(error, "digest")).toBe(digest);
    expect(digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")).toBe(true);
  });

  it("NEXT_REDIRECT digest matches redirect pattern", () => {
    const digest = "NEXT_REDIRECT;replace;/login;307;";
    const error = createErrorWithDigest("Redirect", digest);

    expect(Reflect.get(error, "digest")).toBe(digest);
    expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
  });

  it("regular errors (no digest) are caught by ErrorBoundary", () => {
    const error = new Error("Something broke");
    // No digest property — this is a normal error
    expect("digest" in error).toBe(false);
  });

  it("errors with non-special digests are caught by ErrorBoundary", () => {
    const digest = "SOME_CUSTOM_DIGEST";
    const error = createErrorWithDigest("Custom error", digest);

    expect(Reflect.get(error, "digest")).toBe(digest);
    // These should NOT be re-thrown — they should be caught
    expect(digest).not.toBe("NEXT_NOT_FOUND");
    expect(digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")).toBe(false);
    expect(digest.startsWith("NEXT_REDIRECT;")).toBe(false);
  });
});

// Test the actual ErrorBoundary.getDerivedStateFromError classification.
// The real method THROWS for digest errors (re-throwing them past the boundary)
// and wraps regular thrown values so falsy values remain distinguishable from no error.
describe("ErrorBoundary digest classification (actual class)", () => {
  let ErrorBoundaryInnerClass: ErrorBoundaryInnerConstructor | null = null;
  let ErrorBoundaryInner: ErrorBoundaryInnerConstructor | null = null;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/error-boundary.js");
    const maybeInner = Reflect.get(mod, "ErrorBoundaryInner");
    if (isErrorBoundaryInnerConstructor(maybeInner)) {
      ErrorBoundaryInnerClass = maybeInner;
      ErrorBoundaryInner = maybeInner;
    }
  });

  it("rethrows NEXT_NOT_FOUND", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_NOT_FOUND" });
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;404", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;403", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;403" });
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;401", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;401" });
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_REDIRECT", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("catches regular errors (no digest)", () => {
    const e = new Error("oops");
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    const state = ErrorBoundaryInnerClass?.getDerivedStateFromError(e);
    expect(state).toEqual({ error: { thrownValue: e } });
  });

  it("catches errors with unknown digest", () => {
    const e = Object.assign(new Error(), { digest: "CUSTOM_ERROR" });
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    const state = ErrorBoundaryInnerClass?.getDerivedStateFromError(e);
    expect(state).toEqual({ error: { thrownValue: e } });
  });

  it("catches errors with empty digest", () => {
    const e = Object.assign(new Error(), { digest: "" });
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    const state = ErrorBoundaryInnerClass?.getDerivedStateFromError(e);
    expect(state).toEqual({ error: { thrownValue: e } });
  });

  it("catches falsy thrown values instead of treating them as empty state", () => {
    // Ported from Next.js: test/e2e/app-dir/errors/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/errors/index.test.ts
    expect(ErrorBoundaryInnerClass).not.toBeNull();

    const falsyThrownValues = [undefined, null, 0, "", false];
    for (const thrownValue of falsyThrownValues) {
      const state = ErrorBoundaryInnerClass?.getDerivedStateFromError(thrownValue);
      expect(state).toEqual({ error: { thrownValue } });
    }
  });

  it("resets caught errors when the pathname changes", () => {
    expect(ErrorBoundaryInner).not.toBeNull();
    if (!ErrorBoundaryInner) {
      throw new Error("Expected ErrorBoundaryInner export");
    }

    function Fallback() {
      return null;
    }

    const state = ErrorBoundaryInner.getDerivedStateFromProps(
      {
        children: null,
        fallback: Fallback,
        pathname: "/next",
      },
      {
        error: { thrownValue: new Error("stuck") },
        previousPathname: "/previous",
      },
    );

    expect(state).toEqual({
      error: null,
      previousPathname: "/next",
    });
  });

  it("does not immediately clear a caught error on the same pathname", () => {
    expect(ErrorBoundaryInner).not.toBeNull();
    if (!ErrorBoundaryInner) {
      throw new Error("Expected ErrorBoundaryInner export");
    }

    const error = new Error("stuck");
    const baseState = {
      error: null,
      previousPathname: "/error-test",
    };
    const stateAfterError = {
      ...baseState,
      ...ErrorBoundaryInner.getDerivedStateFromError(error),
    };

    function Fallback() {
      return null;
    }

    const stateAfterProps = ErrorBoundaryInner.getDerivedStateFromProps(
      {
        children: null,
        fallback: Fallback,
        pathname: "/error-test",
      },
      stateAfterError,
    );

    expect(stateAfterProps).toEqual({
      error: { thrownValue: error },
      previousPathname: "/error-test",
    });
  });
});

// Test the actual ForbiddenBoundary.getDerivedStateFromError classification.
// Catches NEXT_HTTP_ERROR_FALLBACK;403 and re-throws everything else.
describe("ForbiddenBoundary digest classification", () => {
  let ForbiddenBoundaryInnerClass: {
    getDerivedStateFromError(error: unknown): Partial<{ forbidden: boolean }>;
  } | null = null;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/error-boundary.js");
    ForbiddenBoundaryInnerClass = Reflect.get(mod, "ForbiddenBoundaryInner") ?? null;
  });

  it("catches NEXT_HTTP_ERROR_FALLBACK;403", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;403" });
    expect(ForbiddenBoundaryInnerClass).not.toBeNull();
    const state = ForbiddenBoundaryInnerClass?.getDerivedStateFromError(e);
    expect(state).toMatchObject({ forbidden: true });
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;404 (notFound domain)", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(ForbiddenBoundaryInnerClass).not.toBeNull();
    expect(() => ForbiddenBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;401 (unauthorized domain)", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;401" });
    expect(ForbiddenBoundaryInnerClass).not.toBeNull();
    expect(() => ForbiddenBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;4030 (defensive: exact match, startsWith would be wrong)", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;4030" });
    expect(ForbiddenBoundaryInnerClass).not.toBeNull();
    expect(() => ForbiddenBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws regular errors (no digest)", () => {
    const e = new Error("oops");
    expect(ForbiddenBoundaryInnerClass).not.toBeNull();
    expect(() => ForbiddenBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });
});

// Test the actual UnauthorizedBoundary.getDerivedStateFromError classification.
// Catches NEXT_HTTP_ERROR_FALLBACK;401 and re-throws everything else.
describe("UnauthorizedBoundary digest classification", () => {
  let UnauthorizedBoundaryInnerClass: {
    getDerivedStateFromError(error: unknown): Partial<{ unauthorized: boolean }>;
  } | null = null;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/error-boundary.js");
    UnauthorizedBoundaryInnerClass = Reflect.get(mod, "UnauthorizedBoundaryInner") ?? null;
  });

  it("catches NEXT_HTTP_ERROR_FALLBACK;401", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;401" });
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    const state = UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e);
    expect(state).toMatchObject({ unauthorized: true });
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;404 (notFound domain)", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    expect(() => UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;403 (forbidden domain)", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;403" });
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    expect(() => UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;4010 (defensive: exact match, startsWith would be wrong)", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;4010" });
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    expect(() => UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws regular errors (no digest)", () => {
    const e = new Error("oops");
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    expect(() => UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });
});
