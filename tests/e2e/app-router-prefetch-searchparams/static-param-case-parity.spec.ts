import { expect, test } from "@playwright/test";

// Next.js exact-matches ordinary generated App paths, while its production
// force-dynamic route is absent from the prerender manifest and bypasses the
// generated-path fallback gate:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/templates/app-page.ts
// Fixture shape ported from:
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/app-prefetch-static/app/%5Bregion%5D/(default)
test.describe("generated App param case parity in production", () => {
  test("preserves each mixed parallel generator result", async ({ request }) => {
    expect((await request.get("/parallel-root-param/en/ownership/stories/main")).status()).toBe(
      200,
    );
    expect((await request.get("/parallel-root-param/en/ownership/stories/parallel")).status()).toBe(
      200,
    );
    expect((await request.get("/parallel-root-param/en/ownership/stories/other")).status()).toBe(
      404,
    );
  });

  test("preserves primary params for an empty parallel result", async ({ request }) => {
    expect(
      (await request.get("/parallel-root-param/en/empty-ownership/stories/main")).status(),
    ).toBe(200);
    expect(
      (await request.get("/parallel-root-param/en/empty-ownership/stories/other")).status(),
    ).toBe(404);
  });

  test("chains generators within one parallel branch", async ({ request }) => {
    expect(
      (await request.get("/parallel-root-param/en/sequential-ownership/stories/b")).status(),
    ).toBe(200);
    for (const slug of ["a", "main", "other"]) {
      expect(
        (
          await request.get(`/parallel-root-param/en/sequential-ownership/stories/${slug}`)
        ).status(),
      ).toBe(404);
    }
  });

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

  test("chains generated parent params through route groups", async ({ request }) => {
    const exact = await request.get("/nextjs-compat/static-param-parent-chain/EU/En");
    expect(exact.status()).toBe(200);
    expect(await exact.text()).toContain("Parent chain: <!-- -->EU<!-- -->/<!-- -->En");

    for (const pathname of [
      "/nextjs-compat/static-param-parent-chain/eu/En",
      "/nextjs-compat/static-param-parent-chain/EU/en",
      "/nextjs-compat/static-param-parent-chain/EU/Fr",
    ]) {
      expect((await request.get(pathname)).status(), pathname).toBe(404);
    }
  });
});
