/**
 * Next.js Compatibility Tests: app-middleware
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-middleware/app-middleware.test.ts
 *
 * HTTP-testable subset only:
 * - middleware can mutate request headers seen by app pages and pages API routes
 * - internal x-middleware-* control headers are stripped from responses
 * - middleware can enable draft mode
 * - middleware response Link headers are preserved
 * - middleware can use unstable_cache and return direct JSON responses
 * - a plain Location response header is not treated as a rewrite/redirect
 */

import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { fetchDom, fetchJson, startFixtureServer } from "../helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/app-middleware-compat");

async function readHeadersFromPage(baseUrl: string, urlPath: string, init?: RequestInit) {
  const { res, $ } = await fetchDom(baseUrl, urlPath, init);
  return {
    res,
    data: JSON.parse($("#headers").text()) as Record<string, string>,
  };
}

describe("Next.js compat: app-middleware", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/headers`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  describe.each([
    {
      title: "pages API route",
      path: "/api/dump-headers-serverless",
      toJson: (baseUrl: string, urlPath: string, init?: RequestInit) =>
        fetchJson(baseUrl, urlPath, init).then(({ res, data }) => ({
          res,
          data: data as Record<string, string>,
        })),
    },
    {
      title: "next/headers page",
      path: "/headers",
      toJson: (baseUrl: string, urlPath: string, init?: RequestInit) =>
        readHeadersFromPage(baseUrl, urlPath, init),
    },
  ])("middleware request header mutations for $title", ({ path, toJson }) => {
    // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-middleware/app-middleware.test.ts
    it("adds new headers", async () => {
      const { data } = await toJson(baseUrl, path, {
        headers: {
          "x-from-client": "hello-from-client",
        },
      });

      expect(data).toMatchObject({
        "x-from-client": "hello-from-client",
        "x-from-middleware": "hello-from-middleware",
      });
    });

    it("deletes headers", async () => {
      const { res, data } = await toJson(
        baseUrl,
        `${path}?remove-headers=x-from-client1,x-from-client2`,
        {
          headers: {
            "x-from-client1": "hello-from-client",
            "X-From-Client2": "hello-from-client",
          },
        },
      );

      expect(data).not.toHaveProperty("x-from-client1");
      expect(data).not.toHaveProperty("X-From-Client2");
      expect(data).toMatchObject({
        "x-from-middleware": "hello-from-middleware",
      });

      expect(res.headers.get("x-middleware-override-headers")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-from-middleware")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-from-client1")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-from-client2")).toBeNull();
    });

    it("updates headers", async () => {
      const { res, data } = await toJson(
        baseUrl,
        `${path}?update-headers=x-from-client1=new-value1,x-from-client2=new-value2`,
        {
          headers: {
            "x-from-client1": "old-value1",
            "X-From-Client2": "old-value2",
            "x-from-client3": "old-value3",
          },
        },
      );

      expect(data).toMatchObject({
        "x-from-client1": "new-value1",
        "x-from-client2": "new-value2",
        "x-from-client3": "old-value3",
        "x-from-middleware": "hello-from-middleware",
      });

      expect(res.headers.get("x-middleware-override-headers")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-from-middleware")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-from-client1")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-from-client2")).toBeNull();
      expect(res.headers.get("x-middleware-request-x-from-client3")).toBeNull();
    });

    it("supports draft mode", async () => {
      const res = await fetch(`${baseUrl}${path}?draft=true`);
      const setCookies = res.headers.getSetCookie();
      expect(setCookies.some((cookie) => cookie.includes("__prerender_bypass"))).toBe(true);
    });
  });

  it("retains a link response header from middleware", async () => {
    const res = await fetch(`${baseUrl}/preloads`);
    expect(res.headers.get("link")).toContain(
      '<https://example.com/page>; rel="alternate"; hreflang="en"',
    );
  });

  it("supports unstable_cache in middleware", async () => {
    const { res, data } = await fetchJson(baseUrl, "/unstable-cache");
    expect(res.status).toBe(200);
    expect(data).toEqual({
      value: expect.any(String),
    });
  });

  it("does not incorrectly treat a Location header as a rewrite", async () => {
    const { res, data } = await fetchJson(baseUrl, "/test-location-header");
    expect(res.status).toBe(200);
    expect(data).toEqual({ foo: "bar" });
    expect(res.headers.get("location")).toBe(
      "https://next-data-api-endpoint.vercel.app/api/random",
    );
  });
});
