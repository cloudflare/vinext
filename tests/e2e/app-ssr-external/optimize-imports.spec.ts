import { test, expect } from "@playwright/test";

// The fixture sets `ssr.external: true` and lists fake-external-barrel in
// optimizePackageImports. Its fake react-aria-components has a subpath barrel,
// which vinext optimizes in RSC.
test("rewrites optimized barrel imports when every dependency is external", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const html = await res.text();
  // Like Next.js, optimized packages stay bundled, so the RSC and SSR imports
  // are rewritten and the barrels' unused leaves are never evaluated.
  for (const [id, text] of [
    ["server-external", "external-used"],
    ["client-external", "external-used"],
    ["server-subpath", "toast-used"],
  ]) {
    expect(html).toMatch(
      new RegExp(`data-testid="${id}" data-unused-loaded="false"[^>]*>${text}<`),
    );
  }
});
