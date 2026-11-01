import { describe, expect, it } from "vite-plus/test";
import {
  BailoutToCSRError,
  DynamicServerError,
} from "../packages/vinext/src/shims/navigation-errors.js";
import { PRERENDER_BINDINGS_UNAVAILABLE_KEY } from "../packages/vinext/src/server/prerender-bindings-unavailable.js";
import { isPrerenderBuildFailingError } from "../packages/vinext/src/server/prerender-render-error.js";

function bindingsUnavailableError(): Error {
  const error = new Error("Cloudflare bindings are unavailable during build-time prerendering.");
  Object.defineProperty(error, Symbol.for(PRERENDER_BINDINGS_UNAVAILABLE_KEY), { value: true });
  return error;
}

describe("isPrerenderBuildFailingError", () => {
  it("fails the build on a user error or thrown value", () => {
    expect(isPrerenderBuildFailingError(new Error("boom"))).toBe(true);
    expect(isPrerenderBuildFailingError("boom")).toBe(true);
    expect(isPrerenderBuildFailingError(Object.assign(new Error("x"), { digest: "123" }))).toBe(
      true,
    );
    // A digest that only looks like a navigation signal.
    for (const digest of ["NEXT_HTTP_ERROR_FALLBACK;500", "NEXT_REDIRECT;garbage"]) {
      expect(isPrerenderBuildFailingError(Object.assign(new Error(digest), { digest }))).toBe(true);
    }
  });

  it("skips the errors Next.js expects during a prerender", () => {
    for (const digest of ["NEXT_REDIRECT;replace;/to;307;", "NEXT_HTTP_ERROR_FALLBACK;404"]) {
      expect(isPrerenderBuildFailingError(Object.assign(new Error(digest), { digest }))).toBe(
        false,
      );
    }
    expect(isPrerenderBuildFailingError(new BailoutToCSRError("useSearchParams()"))).toBe(false);
    expect(isPrerenderBuildFailingError(new DynamicServerError("cookies"))).toBe(false);
    expect(isPrerenderBuildFailingError(new DOMException("aborted", "AbortError"))).toBe(false);
  });

  it("skips a binding the prerender can't provide, also as a cause or sanitized", () => {
    expect(isPrerenderBuildFailingError(bindingsUnavailableError())).toBe(false);
    const sanitized = new Error("An error occurred in the Server Components render.");
    Object.defineProperty(sanitized, Symbol.for("vinext.originalServerError"), {
      value: bindingsUnavailableError(),
    });
    expect(isPrerenderBuildFailingError(sanitized)).toBe(false);
    expect(
      isPrerenderBuildFailingError(
        new Error("query failed", {
          cause: new Error("db", { cause: bindingsUnavailableError() }),
        }),
      ),
    ).toBe(false);

    const cyclic: Error & { cause?: unknown } = new Error("cyclic");
    cyclic.cause = cyclic;
    expect(isPrerenderBuildFailingError(cyclic)).toBe(true);
  });
});
