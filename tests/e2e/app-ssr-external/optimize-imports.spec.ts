import { test, expect } from "@playwright/test";

// The fixture sets `ssr.external: true` and lists fake-external-barrel in
// optimizePackageImports. Its fake react-aria-components has a subpath barrel,
// which vinext optimizes in RSC, re-exporting an external package and a
// bundled one that only the barrel's package can resolve.
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
  expect(html).toMatch(/data-testid="toast-queue">function</);
  expect(html).toMatch(/data-testid="toast-hook">function</);
});

// antd is on vinext's default list. Like the real package, the fake's ES build
// deep-imports rc-util, which Node can't load natively, so SSR must keep the
// whole package external rather than bundle it for every import shape.
test("keeps default-list packages external in SSR", async ({ request }) => {
  const res = await request.get("/default-barrel");
  expect(res.status()).toBe(200);
  const html = await res.text();
  for (const id of ["named", "namespace", "reexport"]) {
    expect(html).toContain(`data-testid="${id}">antd-button<`);
  }
});
