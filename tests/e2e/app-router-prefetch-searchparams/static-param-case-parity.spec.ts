import { expect, test } from "@playwright/test";

// Next.js exact-matches ordinary generated App paths, while its production
// force-dynamic route is absent from the prerender manifest and bypasses the
// generated-path fallback gate:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/templates/app-page.ts
// Fixture shape ported from:
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/app-prefetch-static/app/%5Bregion%5D/(default)
test.describe("generated App param case parity in production", () => {
  test("exact-matches scalar and catch-all generated params", async ({ request }) => {
    for (const pathname of [
      "/nextjs-compat/static-param-case-parity/scalar/AbC",
      "/nextjs-compat/static-param-case-parity/catch-all/AbC/DeF",
    ]) {
      const response = await request.get(pathname);
      expect(response.status(), pathname).toBe(200);
    }

    for (const pathname of [
      "/nextjs-compat/static-param-case-parity/scalar/abc",
      "/nextjs-compat/static-param-case-parity/scalar/aBc",
      "/nextjs-compat/static-param-case-parity/catch-all/abc/def",
      "/nextjs-compat/static-param-case-parity/catch-all/AbC/def",
    ]) {
      const response = await request.get(pathname);
      expect(response.status(), pathname).toBe(404);
    }
  });

  test("bypasses generated-path enforcement for force-dynamic routes", async ({ request }) => {
    for (const region of ["SE", "se", "FR", "xx"]) {
      const response = await request.get(
        `/nextjs-compat/static-param-case-parity/force-dynamic/${region}/static-prefetch`,
      );
      expect(response.status(), region).toBe(200);
      expect(await response.text()).toMatch(new RegExp(`Region: (?:<!-- -->)?${region}`));
    }
  });
});
