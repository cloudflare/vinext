import { describe, it, expect } from "vite-plus/test";
import {
  isNextDataPathname,
  parseNextDataPathname,
  buildNextDataJsonResponse,
  buildNextDataNotFoundResponse,
} from "../packages/vinext/src/server/pages-data-route.js";

// Helper mirroring vinext/html safeJsonStringify behavior for tests.
const safeJsonStringify = (value: unknown) => JSON.stringify(value);

describe("pages-data-route", () => {
  describe("isNextDataPathname", () => {
    it("returns true for valid _next/data paths regardless of buildId", () => {
      expect(isNextDataPathname("/_next/data/abc/about.json")).toBe(true);
      expect(isNextDataPathname("/_next/data/abc/en/about.json")).toBe(true);
      expect(isNextDataPathname("/_next/data/wrong/about.json")).toBe(true);
    });

    it("returns false for non-_next/data paths", () => {
      expect(isNextDataPathname("/about")).toBe(false);
      expect(isNextDataPathname("/_next/static/chunks/foo.js")).toBe(false);
      expect(isNextDataPathname("/_next/data/abc/about")).toBe(false); // no .json
      expect(isNextDataPathname("/data/abc/about.json")).toBe(false);
    });
  });

  describe("parseNextDataPathname", () => {
    const BUILD_ID = "abc123";

    it("extracts the page pathname from a flat route", () => {
      expect(parseNextDataPathname(`/_next/data/${BUILD_ID}/about.json`, BUILD_ID)).toEqual({
        pagePathname: "/about",
      });
    });

    it("preserves locale prefix (handled by downstream i18n resolver)", () => {
      expect(parseNextDataPathname(`/_next/data/${BUILD_ID}/en/about.json`, BUILD_ID)).toEqual({
        pagePathname: "/en/about",
      });
    });

    it("preserves nested segments", () => {
      expect(parseNextDataPathname(`/_next/data/${BUILD_ID}/blog/post-1.json`, BUILD_ID)).toEqual({
        pagePathname: "/blog/post-1",
      });
    });

    it("denormalizes `index` to `/`", () => {
      expect(parseNextDataPathname(`/_next/data/${BUILD_ID}/index.json`, BUILD_ID)).toEqual({
        pagePathname: "/",
      });
    });

    it("denormalizes trailing `/index` to a directory", () => {
      expect(parseNextDataPathname(`/_next/data/${BUILD_ID}/en/index.json`, BUILD_ID)).toEqual({
        pagePathname: "/en",
      });
    });

    it("returns null for a mismatched buildId", () => {
      expect(parseNextDataPathname(`/_next/data/other-build/about.json`, BUILD_ID)).toBeNull();
    });

    it("returns null when the prefix is missing the trailing slash", () => {
      expect(parseNextDataPathname(`/_next/data/${BUILD_ID}.json`, BUILD_ID)).toBeNull();
    });

    it("returns null for empty page segment", () => {
      expect(parseNextDataPathname(`/_next/data/${BUILD_ID}/.json`, BUILD_ID)).toBeNull();
    });

    it("returns null for non-_next/data paths", () => {
      expect(parseNextDataPathname("/about", BUILD_ID)).toBeNull();
      expect(parseNextDataPathname("/_next/static/x.json", BUILD_ID)).toBeNull();
    });

    it("returns null when buildId is empty", () => {
      expect(parseNextDataPathname(`/_next/data/abc/about.json`, "")).toBeNull();
    });
  });

  describe("buildNextDataJsonResponse", () => {
    it("returns a 200 JSON envelope with pageProps key", async () => {
      const res = buildNextDataJsonResponse({ message: "hi" }, safeJsonStringify);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(await res.json()).toEqual({ pageProps: { message: "hi" } });
    });
  });

  describe("buildNextDataNotFoundResponse", () => {
    it("returns a 404 JSON response with empty body", async () => {
      const res = buildNextDataNotFoundResponse();
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      // Body is `{}` — clients blindly calling `.json()` won't throw before
      // checking the status code.
      expect(await res.json()).toEqual({});
    });
  });
});
