import { expect, test } from "@playwright/test";

// Next.js exact-matches generated App paths in dev:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/dev/next-dev-server.ts
// The force-dynamic fixture mirrors Next.js' app-prefetch-static route shape:
// https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/app-prefetch-static/app/%5Bregion%5D/(default)
test.describe("generated App param case parity in dev", () => {
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

  test("keeps force-dynamic routes on the dev exact-match gate", async ({ request }) => {
    const exact = await request.get(
      "/nextjs-compat/static-param-case-parity/force-dynamic/SE/static-prefetch",
    );
    expect(exact.status()).toBe(200);

    for (const region of ["se", "FR", "xx"]) {
      const response = await request.get(
        `/nextjs-compat/static-param-case-parity/force-dynamic/${region}/static-prefetch`,
      );
      expect(response.status(), region).toBe(404);
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
