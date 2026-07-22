import { describe, it, expect } from "vite-plus/test";
import {
  buildMiddlewarePrefetchSkipResponse,
  isNextDataPathname,
  parseNextDataPathname,
  buildNextDataJsonResponse,
  buildNextDataNotFoundResponse,
  encodeUrlParserIgnoredCharacters,
  normalizePagesDataRequest,
  normalizeNextDataPagePathname,
  urlParserCreatesPagesDataPath,
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

  describe("urlParserCreatesPagesDataPath", () => {
    it("detects ignored controls that manufacture a data path", () => {
      expect(urlParserCreatesPagesDataPath("/\t_next/data/abc/about.json")).toBe(true);
      expect(urlParserCreatesPagesDataPath("/_ne\nxt/data/abc/about.json")).toBe(true);
      expect(urlParserCreatesPagesDataPath("/_next/\rdata/abc/about.json")).toBe(true);
    });

    it("preserves ordinary controls and canonical data paths", () => {
      expect(urlParserCreatesPagesDataPath("/posts/foo\t")).toBe(false);
      expect(urlParserCreatesPagesDataPath("/_next/data/abc/about.json")).toBe(false);
      expect(urlParserCreatesPagesDataPath("/about")).toBe(false);
    });
  });

  it("keeps URL-parser-ignored characters encoded for later parameter decoding", () => {
    expect(encodeUrlParserIgnoredCharacters("/posts/a\tb\nc\rd")).toBe("/posts/a%09b%0Ac%0Dd");
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

  describe("buildMiddlewarePrefetchSkipResponse", () => {
    // Ported from Next.js: packages/next/src/server/base-server.ts
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/base-server.ts
    it("returns the middleware prefetch bail protocol for non-SSG data routes", async () => {
      const res = buildMiddlewarePrefetchSkipResponse("/ssr");

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("x-matched-path")).toBe("/ssr");
      expect(res.headers.get("x-middleware-skip")).toBe("1");
      expect(res.headers.get("Cache-Control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      expect(await res.json()).toEqual({});
    });
  });

  describe("normalizePagesDataRequest", () => {
    it("applies trailingSlash to the page URL before middleware sees data requests", () => {
      // Mirrors Next.js middleware-trailing-slash data-request coverage:
      // test/e2e/middleware-trailing-slash/test/index.test.ts.
      const buildId = "abc123";
      const req = new Request(`http://localhost/_next/data/${buildId}/ssr-page.json?x=1`);
      const result = normalizePagesDataRequest(req, buildId, "", true);

      expect(result.isDataReq).toBe(true);
      expect(result.normalizedPathname).toBe("/ssr-page/");
      expect(result.request.url).toBe("http://localhost/ssr-page/?x=1");
    });

    it("preserves the root pathname when trailingSlash is enabled", () => {
      expect(normalizeNextDataPagePathname("/", true)).toBe("/");
    });

    it("recognizes a data URL under basePath while preserving basePath for middleware", () => {
      const buildId = "abc123";
      const req = new Request(`http://localhost/root/_next/data/${buildId}/about.json?x=1`);
      const result = normalizePagesDataRequest(req, buildId, "/root");

      expect(result.isDataReq).toBe(true);
      expect(result.normalizedPathname).toBe("/about");
      expect(result.search).toBe("?x=1");
      expect(result.request.url).toBe("http://localhost/root/about?x=1");
      expect(result.notFoundResponse).toBeNull();
    });

    it("applies trailingSlash after preserving basePath for middleware", () => {
      const buildId = "abc123";
      const req = new Request(`http://localhost/root/_next/data/${buildId}/about.json?x=1`);
      const result = normalizePagesDataRequest(req, buildId, "/root", true);

      expect(result.isDataReq).toBe(true);
      expect(result.normalizedPathname).toBe("/about/");
      expect(result.request.url).toBe("http://localhost/root/about/?x=1");
    });

    it("preserves an absolute data URL outside the configured basePath", () => {
      const buildId = "abc123";
      const req = new Request(`http://localhost/_next/data/${buildId}/about.json?x=1`);
      const result = normalizePagesDataRequest(req, buildId, "/root");

      expect(result.isDataReq).toBe(true);
      expect(result.normalizedPathname).toBe("/about");
      expect(result.request.url).toBe("http://localhost/about?x=1");
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

    it("sets x-nextjs-deployment-id when __VINEXT_DEPLOYMENT_ID is set", async () => {
      const saved = process.env.__VINEXT_DEPLOYMENT_ID;
      process.env.__VINEXT_DEPLOYMENT_ID = "deploy-abc123";
      try {
        const res = buildNextDataNotFoundResponse();
        expect(res.headers.get("x-nextjs-deployment-id")).toBe("deploy-abc123");
      } finally {
        if (saved === undefined) {
          delete process.env.__VINEXT_DEPLOYMENT_ID;
        } else {
          process.env.__VINEXT_DEPLOYMENT_ID = saved;
        }
      }
    });

    it("sets x-nextjs-deployment-id from NEXT_DEPLOYMENT_ID when __VINEXT_DEPLOYMENT_ID is absent", async () => {
      const savedVinext = process.env.__VINEXT_DEPLOYMENT_ID;
      const savedNext = process.env.NEXT_DEPLOYMENT_ID;
      delete process.env.__VINEXT_DEPLOYMENT_ID;
      process.env.NEXT_DEPLOYMENT_ID = "next-deploy-xyz";
      try {
        const res = buildNextDataNotFoundResponse();
        expect(res.headers.get("x-nextjs-deployment-id")).toBe("next-deploy-xyz");
      } finally {
        if (savedVinext === undefined) {
          delete process.env.__VINEXT_DEPLOYMENT_ID;
        } else {
          process.env.__VINEXT_DEPLOYMENT_ID = savedVinext;
        }
        if (savedNext === undefined) {
          delete process.env.NEXT_DEPLOYMENT_ID;
        } else {
          process.env.NEXT_DEPLOYMENT_ID = savedNext;
        }
      }
    });

    it("omits x-nextjs-deployment-id when no deployment env var is set", async () => {
      const savedVinext = process.env.__VINEXT_DEPLOYMENT_ID;
      const savedNext = process.env.NEXT_DEPLOYMENT_ID;
      delete process.env.__VINEXT_DEPLOYMENT_ID;
      delete process.env.NEXT_DEPLOYMENT_ID;
      try {
        const res = buildNextDataNotFoundResponse();
        expect(res.headers.get("x-nextjs-deployment-id")).toBeNull();
      } finally {
        if (savedVinext !== undefined) process.env.__VINEXT_DEPLOYMENT_ID = savedVinext;
        if (savedNext !== undefined) process.env.NEXT_DEPLOYMENT_ID = savedNext;
      }
    });
  });

  describe("normalizePagesDataRequest — wrong buildId", () => {
    const BUILD_ID = "correct-build-id";

    it("returns a notFoundResponse with x-nextjs-deployment-id when buildId is wrong", async () => {
      const savedId = process.env.__VINEXT_DEPLOYMENT_ID;
      process.env.__VINEXT_DEPLOYMENT_ID = "deploy-skew-guard";
      try {
        const req = new Request("http://localhost/_next/data/stale-build-id/about.json");
        const result = normalizePagesDataRequest(req, BUILD_ID);
        expect(result.isDataReq).toBe(false);
        expect(result.notFoundResponse).not.toBeNull();
        expect(result.notFoundResponse!.status).toBe(404);
        expect(result.notFoundResponse!.headers.get("x-nextjs-deployment-id")).toBe(
          "deploy-skew-guard",
        );
      } finally {
        if (savedId === undefined) {
          delete process.env.__VINEXT_DEPLOYMENT_ID;
        } else {
          process.env.__VINEXT_DEPLOYMENT_ID = savedId;
        }
      }
    });

    it("returns a notFoundResponse with x-nextjs-deployment-id when buildId is null (no build)", async () => {
      const savedId = process.env.__VINEXT_DEPLOYMENT_ID;
      process.env.__VINEXT_DEPLOYMENT_ID = "deploy-null-build";
      try {
        const req = new Request("http://localhost/_next/data/any-build-id/about.json");
        const result = normalizePagesDataRequest(req, null);
        expect(result.notFoundResponse).not.toBeNull();
        expect(result.notFoundResponse!.headers.get("x-nextjs-deployment-id")).toBe(
          "deploy-null-build",
        );
      } finally {
        if (savedId === undefined) {
          delete process.env.__VINEXT_DEPLOYMENT_ID;
        } else {
          process.env.__VINEXT_DEPLOYMENT_ID = savedId;
        }
      }
    });
  });
});
