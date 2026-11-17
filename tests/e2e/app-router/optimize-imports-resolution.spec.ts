import { test, expect } from "@playwright/test";

// Both barrels are in the fixture's optimizePackageImports.
test.describe("optimizePackageImports barrel resolution", () => {
  test("analyzes the barrel entry Vite resolves for the export conditions", async ({ request }) => {
    const res = await request.get("/optimize-imports-resolution");
    expect(res.status()).toBe(200);
    const html = await res.text();
    // fake-export-order-barrel lists "module" before "node". Vite loads the
    // ESM entry, so the rewrite must read that entry rather than the CJS one,
    // and its unused leaf is never evaluated in RSC or SSR.
    for (const id of ["server-export-order", "client-export-order"]) {
      expect(html).toMatch(
        new RegExp(`data-testid="${id}" data-unused-loaded="false"[^>]*>export-order-used<`),
      );
    }
  });

  test("resolves each importer's own copy of the barrel and its dependencies", async ({
    request,
  }) => {
    const res = await request.get("/optimize-imports-resolution");
    expect(res.status()).toBe(200);
    const html = await res.text();
    // The app installs fake-copy-barrel v1. The fake-copy-consumer workspace
    // package installs v2, and each copy re-exports its own fake-copy-leaf.
    expect(html).toContain('data-testid="app-copy-local">barrel-v1<');
    expect(html).toContain('data-testid="app-copy-leaf">leaf-v1<');
    expect(html).toContain('data-testid="consumer-copy-local">barrel-v2<');
    expect(html).toContain('data-testid="consumer-copy-leaf">leaf-v2<');
  });
});
