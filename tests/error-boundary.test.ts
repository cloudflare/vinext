/**
 * Error boundary unit tests.
 *
 * Tests the ErrorBoundary, NotFoundBoundary, ForbiddenBoundary, and
 * UnauthorizedBoundary components that handle error.tsx, not-found.tsx,
 * forbidden.tsx, and unauthorized.tsx rendering in the App Router.
 * Verifies correct digest handling, error propagation, and reset behavior.
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
// Next.js keeps pathname reset fallback in the boundary implementation, while
// segment remounts provide the App Router's preferred reset owner. These tests
// lock both paths.

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
      resetKey?: string | null;
    },
    state: {
      error: { thrownValue: unknown } | null;
      previousPathname: string;
      previousResetKey?: string | null;
    },
  ): {
    error: { thrownValue: unknown } | null;
    previousPathname: string;
    previousResetKey?: string | null;
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
    const e = createErrorWithDigest("NEXT_NOT_FOUND", "NEXT_NOT_FOUND");
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;404", () => {
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;404", "NEXT_HTTP_ERROR_FALLBACK;404");
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;403", () => {
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;403", "NEXT_HTTP_ERROR_FALLBACK;403");
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;401", () => {
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;401", "NEXT_HTTP_ERROR_FALLBACK;401");
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    expect(() => ErrorBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_REDIRECT", () => {
    const e = createErrorWithDigest(
      "NEXT_REDIRECT;replace;/login;307;",
      "NEXT_REDIRECT;replace;/login;307;",
    );
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
    const e = createErrorWithDigest("CUSTOM_ERROR", "CUSTOM_ERROR");
    expect(ErrorBoundaryInnerClass).not.toBeNull();
    const state = ErrorBoundaryInnerClass?.getDerivedStateFromError(e);
    expect(state).toEqual({ error: { thrownValue: e } });
  });

  it("catches errors with empty digest", () => {
    const e = createErrorWithDigest("Empty digest", "");
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
        previousResetKey: null,
      },
    );

    expect(state).toEqual({
      error: null,
      previousPathname: "/next",
      previousResetKey: null,
    });
  });

  it("resets caught errors when the semantic reset key changes on the same pathname", () => {
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
        pathname: "/products/[id]",
        resetKey: "product-b",
      },
      {
        error: { thrownValue: new Error("stuck") },
        previousPathname: "/products/[id]",
        previousResetKey: "product-a",
      },
    );

    expect(state).toEqual({
      error: null,
      previousPathname: "/products/[id]",
      previousResetKey: "product-b",
    });
  });

  it("treats an empty semantic reset key as absent for pathname fallback", () => {
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
        resetKey: "",
      },
      {
        error: { thrownValue: new Error("stuck") },
        previousPathname: "/previous",
        previousResetKey: "",
      },
    );

    expect(state).toEqual({
      error: null,
      previousPathname: "/next",
      previousResetKey: null,
    });
  });

  it("keeps caught errors when the semantic reset key is unchanged", () => {
    expect(ErrorBoundaryInner).not.toBeNull();
    if (!ErrorBoundaryInner) {
      throw new Error("Expected ErrorBoundaryInner export");
    }

    const error = new Error("stuck");

    function Fallback() {
      return null;
    }

    const state = ErrorBoundaryInner.getDerivedStateFromProps(
      {
        children: null,
        fallback: Fallback,
        pathname: "/products/next",
        resetKey: "product-a",
      },
      {
        error: { thrownValue: error },
        previousPathname: "/products/previous",
        previousResetKey: "product-a",
      },
    );

    expect(state).toEqual({
      error: { thrownValue: error },
      previousPathname: "/products/next",
      previousResetKey: "product-a",
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
      previousResetKey: null,
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
      previousResetKey: null,
    });
  });
});

describe("RedirectBoundary digest classification", () => {
  let RedirectErrorBoundaryClass: {
    getDerivedStateFromError(error: unknown): {
      redirect: string | null;
      redirectType: "push" | "replace" | null;
    };
  } | null = null;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/error-boundary.js");
    RedirectErrorBoundaryClass = Reflect.get(mod, "RedirectErrorBoundary") ?? null;
  });

  it("catches Vinext redirect digests and decodes the target", () => {
    const e = Object.assign(new Error("NEXT_REDIRECT:/?auth=required"), {
      digest: "NEXT_REDIRECT;;%2F%3Fauth%3Drequired",
    });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toEqual({
      redirect: "/?auth=required",
      redirectType: "replace",
    });
  });

  it("catches Next-style redirect digests and preserves push type", () => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;push;/login;307;",
    });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toEqual({
      redirect: "/login",
      redirectType: "push",
    });
  });

  it("preserves semicolons inside redirect digest URLs", () => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;javascript:window.location.assign('/boom');;307;",
    });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toEqual({
      redirect: "javascript:window.location.assign('/boom');",
      redirectType: "replace",
    });
  });

  it("preserves percent escapes in Next-style raw redirect URLs", () => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/docs%2Fguide%3Bpart;307;",
    });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toEqual({
      redirect: "/docs%2Fguide%3Bpart",
      redirectType: "replace",
    });
  });

  it("catches Next-style redirect digests with an empty URL", () => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;;307;",
    });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toEqual({
      redirect: "",
      redirectType: "replace",
    });
  });

  it("re-throws non-redirect errors", () => {
    const e = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(() => RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws incomplete redirect digests", () => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;push",
    });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(() => RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws Next-style redirect errors with a malformed status", () => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;invalid;",
    });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(() => RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("returns null state for handled redirect errors (Next.js parity placeholder)", () => {
    const e = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;;%2Flogin",
      handled: true,
    });

    expect(RedirectErrorBoundaryClass).not.toBeNull();
    expect(RedirectErrorBoundaryClass?.getDerivedStateFromError(e)).toEqual({
      redirect: null,
      redirectType: null,
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
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;403", "NEXT_HTTP_ERROR_FALLBACK;403");
    expect(ForbiddenBoundaryInnerClass).not.toBeNull();
    const state = ForbiddenBoundaryInnerClass?.getDerivedStateFromError(e);
    expect(state).toMatchObject({ forbidden: true });
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;404 (notFound domain)", () => {
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;404", "NEXT_HTTP_ERROR_FALLBACK;404");
    expect(ForbiddenBoundaryInnerClass).not.toBeNull();
    expect(() => ForbiddenBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;401 (unauthorized domain)", () => {
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;401", "NEXT_HTTP_ERROR_FALLBACK;401");
    expect(ForbiddenBoundaryInnerClass).not.toBeNull();
    expect(() => ForbiddenBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;4030 (defensive: exact match, startsWith would be wrong)", () => {
    const e = createErrorWithDigest(
      "NEXT_HTTP_ERROR_FALLBACK;4030",
      "NEXT_HTTP_ERROR_FALLBACK;4030",
    );
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
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;401", "NEXT_HTTP_ERROR_FALLBACK;401");
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    const state = UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e);
    expect(state).toMatchObject({ unauthorized: true });
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;404 (notFound domain)", () => {
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;404", "NEXT_HTTP_ERROR_FALLBACK;404");
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    expect(() => UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;403 (forbidden domain)", () => {
    const e = createErrorWithDigest("NEXT_HTTP_ERROR_FALLBACK;403", "NEXT_HTTP_ERROR_FALLBACK;403");
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    expect(() => UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws NEXT_HTTP_ERROR_FALLBACK;4010 (defensive: exact match, startsWith would be wrong)", () => {
    const e = createErrorWithDigest(
      "NEXT_HTTP_ERROR_FALLBACK;4010",
      "NEXT_HTTP_ERROR_FALLBACK;4010",
    );
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    expect(() => UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });

  it("re-throws regular errors (no digest)", () => {
    const e = new Error("oops");
    expect(UnauthorizedBoundaryInnerClass).not.toBeNull();
    expect(() => UnauthorizedBoundaryInnerClass?.getDerivedStateFromError(e)).toThrow(e);
  });
});
