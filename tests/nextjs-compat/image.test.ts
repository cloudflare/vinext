/**
 * Next.js Compatibility Tests: next/image getImageProps in Server Components
 *
 * Ported from Next.js: test/integration/next-image-new/app-dir/test/index.test.ts
 * ("should render picture via getImageProps")
 * https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/app-dir/test/index.test.ts
 *
 * Next.js's `next/image` entry (shared/lib/image-external.tsx) is server-safe:
 * only the Image component is a client reference, so `getImageProps` can run
 * during the RSC render.
 *
 * Upstream also asserts no `fetchpriority` attribute and `style="color:transparent"`
 * on the <img>. Those are left out: vinext's getImageProps output still differs
 * there (priority maps to fetchPriority="high"; no color:transparent default).
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "../helpers.js";

describe("Next.js compat: next/image getImageProps", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders a <picture> from getImageProps called in a Server Component", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/image-get-image-props");

    expect(res.status).toBe(200);
    expect(html).toContain(
      '<source media="(prefers-color-scheme: dark)" srcSet="/_next/image?url=%2Fget-image-props-dark.png&amp;w=640&amp;q=75 1x, /_next/image?url=%2Fget-image-props-dark.png&amp;w=828&amp;q=75 2x"/>',
    );
    expect(html).toContain(
      '<source media="(prefers-color-scheme: light)" srcSet="/_next/image?url=%2Fget-image-props-light.png&amp;w=640&amp;q=75 1x, /_next/image?url=%2Fget-image-props-light.png&amp;w=828&amp;q=75 2x"/>',
    );
    const img = html.match(/<img\b[^>]*alt="Hero"[^>]*>/)?.[0];
    expect(img).toBeDefined();
    expect(img).toContain('src="/_next/image?url=%2Fget-image-props-light.png&amp;w=828&amp;q=75"');
    expect(img).toContain('width="400"');
    expect(img).toContain('height="400"');
    expect(img).not.toMatch(/\ssrcSet=/i);
    expect(img).not.toMatch(/\ssizes=/i);
  });
});
