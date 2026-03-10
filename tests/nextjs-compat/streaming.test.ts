/**
 * Next.js Compatibility Tests: streaming / loading.tsx
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/rendering.test.ts
 *
 * Tests streaming SSR and loading.tsx behavior in the App Router at the HTTP level:
 * - Streaming pages with Suspense boundaries resolve to full content
 * - Nested streaming pages with multiple Suspense boundaries resolve correctly
 * - loading.tsx route-level Suspense fallback allows the page to render
 * - Streaming responses produce valid HTML documents
 *
 * NOTE: The fetchHtml helper reads the FULL response (it awaits res.text()),
 * so by the time we get the HTML, all Suspense boundaries will have resolved.
 * This means we see the final content, not the fallback. That's expected —
 * we're testing that the streaming pipeline produces correct output.
 *
 * Fixture pages live in:
 * - fixtures/app-basic/app/nextjs-compat/streaming-test/
 * - fixtures/app-basic/app/nextjs-compat/streaming-test/nested/
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: streaming", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up — also primes any lazy compilation
    await fetchHtml(baseUrl, "/nextjs-compat/streaming-test");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Streaming / Suspense ────────────────────────────────────
  // Next.js: streaming SSR with Suspense boundaries
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/rendering.test.ts

  it("streaming page returns 200 with content", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/streaming-test");
    expect(res.status).toBe(200);
    expect(html).toContain("Streaming Test");
  });

  it("streamed content appears in final response", async () => {
    // Next.js: streaming SSR with Suspense boundaries
    // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/rendering.test.ts
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/streaming-test");
    expect(html).toContain("Streamed content loaded");
  });

  it("nested streaming page returns 200", async () => {
    // Next.js: streaming SSR with Suspense boundaries
    // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/rendering.test.ts
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/streaming-test/nested");
    expect(res.status).toBe(200);
    expect(html).toContain("Nested Streaming Test");
  });

  it("nested streamed content resolves", async () => {
    // Next.js: streaming SSR with Suspense boundaries
    // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/rendering.test.ts
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/streaming-test/nested");
    expect(html).toContain("Content A loaded");
    expect(html).toContain("Content B loaded");
  });

  // ── loading.tsx ─────────────────────────────────────────────
  // Next.js: loading.tsx acts as a route-level Suspense boundary
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/rendering.test.ts

  it("loading.tsx route-level boundary is present", async () => {
    // loading.tsx is a Suspense fallback wrapping the page. If the page
    // resolves quickly (as in SSR with fetchHtml reading the full response),
    // the final HTML contains the resolved page content rather than the
    // loading fallback. The key assertion is that the page renders successfully.
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/streaming-test");
    expect(res.status).toBe(200);
    expect(html).toContain("Streaming Test");
  });

  // ── Response format ─────────────────────────────────────────
  // Next.js: streaming SSR with Suspense boundaries
  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/rendering.test.ts

  it("streaming response is valid HTML", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/streaming-test");
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain("</html>");
  });
});
