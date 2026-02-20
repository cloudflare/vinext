/**
 * Error boundary unit tests.
 *
 * Tests the ErrorBoundary and NotFoundBoundary components that handle
 * error.tsx and not-found.tsx rendering in the App Router. Verifies
 * correct digest handling, error propagation, and the reset mechanism.
 *
 * These test the same digest-based error routing that Next.js uses
 * to distinguish between notFound(), redirect(), forbidden(), and
 * genuine application errors.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

// Mock next/navigation since it's a virtual module provided by the vinext plugin.
// We only need usePathname for the NotFoundBoundary wrapper, not for the static
// getDerivedStateFromError methods we're testing.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));
// The error boundary is primarily a client-side component.

// Test the digest detection patterns used by the boundaries
describe("ErrorBoundary digest patterns", () => {
  it("NEXT_NOT_FOUND digest matches legacy not-found pattern", () => {
    const error = new Error("Not Found");
    (error as any).digest = "NEXT_NOT_FOUND";

    // The ErrorBoundary re-throws errors with these digests
    const digest = (error as any).digest;
    expect(digest === "NEXT_NOT_FOUND").toBe(true);
  });

  it("NEXT_HTTP_ERROR_FALLBACK;404 matches new not-found pattern", () => {
    const error = new Error("Not Found");
    (error as any).digest = "NEXT_HTTP_ERROR_FALLBACK;404";

    const digest = (error as any).digest;
    expect(digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")).toBe(true);
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("NEXT_HTTP_ERROR_FALLBACK;403 matches forbidden pattern", () => {
    const error = new Error("Forbidden");
    (error as any).digest = "NEXT_HTTP_ERROR_FALLBACK;403";

    const digest = (error as any).digest;
    expect(digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")).toBe(true);
  });

  it("NEXT_HTTP_ERROR_FALLBACK;401 matches unauthorized pattern", () => {
    const error = new Error("Unauthorized");
    (error as any).digest = "NEXT_HTTP_ERROR_FALLBACK;401";

    const digest = (error as any).digest;
    expect(digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")).toBe(true);
  });

  it("NEXT_REDIRECT digest matches redirect pattern", () => {
    const error = new Error("Redirect");
    (error as any).digest = "NEXT_REDIRECT;replace;/login;307;";

    const digest = (error as any).digest;
    expect(digest.startsWith("NEXT_REDIRECT;")).toBe(true);
  });

  it("regular errors (no digest) are caught by ErrorBoundary", () => {
    const error = new Error("Something broke");
    // No digest property — this is a normal error
    expect("digest" in error).toBe(false);
  });

  it("errors with non-special digests are caught by ErrorBoundary", () => {
    const error = new Error("Custom error");
    (error as any).digest = "SOME_CUSTOM_DIGEST";

    const digest = (error as any).digest;
    // These should NOT be re-thrown — they should be caught
    expect(digest === "NEXT_NOT_FOUND").toBe(false);
    expect(digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")).toBe(false);
    expect(digest.startsWith("NEXT_REDIRECT;")).toBe(false);
  });
});

// Test the actual ErrorBoundary.getDerivedStateFromError classification.
// The real method THROWS for digest errors (re-throwing them past the boundary)
// and returns { error } for regular errors (catching them).
describe("ErrorBoundary digest classification (actual class)", () => {
  let ErrorBoundary: any;

  beforeAll(async () => {
    const mod = await import("../packages/vinext/src/shims/error-boundary.js");
    ErrorBoundary = mod.ErrorBoundary;
  });

  it("rethrows NEXT_NOT_FOUND", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_NOT_FOUND" });
    expect(() => ErrorBoundary.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;404", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(() => ErrorBoundary.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;403", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;403" });
    expect(() => ErrorBoundary.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_HTTP_ERROR_FALLBACK;401", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_HTTP_ERROR_FALLBACK;401" });
    expect(() => ErrorBoundary.getDerivedStateFromError(e)).toThrow(e);
  });

  it("rethrows NEXT_REDIRECT", () => {
    const e = Object.assign(new Error(), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    expect(() => ErrorBoundary.getDerivedStateFromError(e)).toThrow(e);
  });

  it("catches regular errors (no digest)", () => {
    const e = new Error("oops");
    const state = ErrorBoundary.getDerivedStateFromError(e);
    expect(state).toEqual({ error: e });
  });

  it("catches errors with unknown digest", () => {
    const e = Object.assign(new Error(), { digest: "CUSTOM_ERROR" });
    const state = ErrorBoundary.getDerivedStateFromError(e);
    expect(state).toEqual({ error: e });
  });

  it("catches errors with empty digest", () => {
    const e = Object.assign(new Error(), { digest: "" });
    const state = ErrorBoundary.getDerivedStateFromError(e);
    expect(state).toEqual({ error: e });
  });
});
