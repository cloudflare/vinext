/**
 * Next.js Compatibility Tests: rewrites-redirects
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rewrites-redirects/rewrites-redirects.test.ts
 *
 * Covers the two pure-HTTP redirect tests for exotic URL schemes. The full
 * Next.js suite is mostly browser navigation, but these redirects are easy to
 * validate via fetch and exercise next.config redirect URL normalization.
 */

import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { startFixtureServer } from "../helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/app-rewrites-redirects");

describe("Next.js compat: rewrites-redirects", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rewrites-redirects/rewrites-redirects.test.ts
  it("redirects to exotic url schemes preserving slashes", async () => {
    const response = await fetch(`${baseUrl}/config-redirect-itms-apps-slashes`, {
      redirect: "manual",
    });

    expect(response.headers.get("location")).toBe(
      "itms-apps://apps.apple.com/de/app/xcode/id497799835?l=en-GB&mt=12",
    );
    expect(response.status).toBe(308);
  });

  it("redirects to exotic url schemes without adding unwanted slashes", async () => {
    const response = await fetch(`${baseUrl}/config-redirect-itms-apps-no-slashes`, {
      redirect: "manual",
    });

    expect(response.headers.get("location")).toBe(
      "itms-apps:apps.apple.com/de/app/xcode/id497799835?l=en-GB&mt=12",
    );
    expect(response.status).toBe(308);
  });
});
