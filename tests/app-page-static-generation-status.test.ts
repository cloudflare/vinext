import { describe, expect, it } from "vite-plus/test";
import { createAppPageStaticGenerationStatusCapture } from "../packages/vinext/src/server/app-page-static-generation-status.js";

function digestError(digest: string): Error & { digest: string } {
  return Object.assign(new Error(digest), { digest });
}

const ERRORS = {
  "not-found": digestError("NEXT_HTTP_ERROR_FALLBACK;404"),
  unauthorized: digestError("NEXT_HTTP_ERROR_FALLBACK;401"),
  forbidden: digestError("NEXT_HTTP_ERROR_FALLBACK;403"),
  redirect: (destination: string) => digestError(`NEXT_REDIRECT;replace;${destination};307;`),
  "permanent-redirect": (destination: string) =>
    digestError(`NEXT_REDIRECT;replace;${destination};308;`),
};

function errorFor(type: keyof typeof ERRORS, destination: string): Error {
  const error = ERRORS[type];
  return typeof error === "function" ? error(destination) : error;
}

// Ported from Next.js: test/e2e/prerendered-http-status-codes/index.test.ts
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/prerendered-http-status-codes/index.test.ts
describe("createAppPageStaticGenerationStatusCapture", () => {
  it("has no status until the render reports an HTTP error", () => {
    const capture = createAppPageStaticGenerationStatusCapture(undefined);
    capture.capture(new Error("boom"));
    capture.capture(digestError("1234567890"));
    expect(capture.get()).toBeNull();
  });

  it.each([
    ["not-found", "unauthorized", 404],
    ["not-found", "forbidden", 404],
    ["unauthorized", "not-found", 401],
    ["unauthorized", "forbidden", 401],
    ["forbidden", "not-found", 403],
    ["forbidden", "unauthorized", 403],
  ] as const)("keeps the first access fallback: %s before %s", (first, second, status) => {
    const capture = createAppPageStaticGenerationStatusCapture(undefined);
    capture.capture(errorFor(first, "/first"));
    capture.capture(errorFor(second, "/second"));
    expect(capture.get()).toEqual({ status });
  });

  describe.each([
    { redirect: "redirect", status: 307 },
    { redirect: "permanent-redirect", status: 308 },
  ] as const)("$redirect", ({ redirect, status }) => {
    it.each(["not-found", "unauthorized", "forbidden"] as const)(
      "overrides an earlier %s",
      (fallback) => {
        const capture = createAppPageStaticGenerationStatusCapture(undefined);
        capture.capture(errorFor(fallback, "/first"));
        capture.capture(errorFor(redirect, "/second"));
        expect(capture.get()).toEqual({ status, headers: { location: "/second" } });
      },
    );

    it.each(["not-found", "unauthorized", "forbidden"] as const)(
      "takes precedence over a later %s",
      (fallback) => {
        const capture = createAppPageStaticGenerationStatusCapture(undefined);
        capture.capture(errorFor(redirect, "/first"));
        capture.capture(errorFor(fallback, "/second"));
        expect(capture.get()).toEqual({ status, headers: { location: "/first" } });
      },
    );

    it.each(["redirect", "permanent-redirect"] as const)(
      "keeps its status and location when followed by %s",
      (second) => {
        const capture = createAppPageStaticGenerationStatusCapture(undefined);
        capture.capture(errorFor(redirect, "/first"));
        capture.capture(errorFor(second, "/second"));
        expect(capture.get()).toEqual({ status, headers: { location: "/first" } });
      },
    );
  });

  it("prefixes a redirect's location with the basePath", () => {
    const capture = createAppPageStaticGenerationStatusCapture("/docs");
    capture.capture(errorFor("redirect", "/target"));
    expect(capture.get()).toEqual({ status: 307, headers: { location: "/docs/target" } });
  });
});
