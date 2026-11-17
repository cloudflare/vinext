import { test, expect } from "@playwright/test";

// The fixture sets `ssr.external: true` and lists fake-external-barrel in
// optimizePackageImports.
test("rewrites optimized barrel imports when every dependency is external", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const html = await res.text();
  // Like Next.js, the optimized package stays bundled, so the RSC and SSR
  // imports are rewritten and the barrel's unused leaf is never evaluated.
  for (const id of ["server-external", "client-external"]) {
    expect(html).toMatch(
      new RegExp(`data-testid="${id}" data-unused-loaded="false"[^>]*>external-used<`),
    );
  }
});
