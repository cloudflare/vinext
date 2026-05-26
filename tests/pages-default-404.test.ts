/**
 * Regression for #1454.
 *
 * The Pages Router default 404 response (used when no `pages/404.tsx` and no
 * `pages/_error.tsx` is defined) must include the canonical Next.js body
 * `"This page could not be found."` (with trailing period). Pre-fix vinext
 * shipped a minimal `<h1>404 - Page not found</h1>` placeholder that broke
 * deploy-suite parity against `test/e2e/getserversideprops/test/index.test.ts`
 * and `test/e2e/basepath/error-pages.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  buildDefaultPagesNotFoundResponse,
  DEFAULT_PAGES_NOT_FOUND_HTML,
} from "../packages/vinext/src/server/pages-default-404.js";

describe("buildDefaultPagesNotFoundResponse", () => {
  it("returns a 404 status with the canonical Next.js body", async () => {
    const response = buildDefaultPagesNotFoundResponse();
    expect(response.status).toBe(404);
    const body = await response.text();
    // The Next.js deploy suite asserts on this substring (with the trailing
    // period — see test/e2e/basepath/error-pages.test.ts).
    expect(body).toContain("This page could not be found.");
    // The 404 status code is rendered in the heading.
    expect(body).toContain("404");
    // Old vinext placeholder body must NOT leak through.
    expect(body).not.toContain("404 - Page not found");
  });

  it("uses Next.js-compatible content-type", () => {
    const response = buildDefaultPagesNotFoundResponse();
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("exposes the raw HTML body for callers that need it", () => {
    expect(DEFAULT_PAGES_NOT_FOUND_HTML).toContain("This page could not be found.");
    expect(DEFAULT_PAGES_NOT_FOUND_HTML).toContain("<!DOCTYPE html>");
  });
});
