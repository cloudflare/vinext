import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4175";

// The fixture's @tremor/react is a fake native ESM barrel. Its name is on the
// default optimizePackageImports list, which the fixture config doesn't extend.
// The dev-server companion is tests/e2e/pages-router/optimize-imports-default.spec.ts.
test("rewrites default optimized barrel imports in Pages Router pages", async ({ request }) => {
  const res = await request.get(`${BASE}/optimize-imports-default`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  // Like Next.js, the server bundles the optimized package rather than leaving
  // it external, so the import is rewritten and the unused leaf never loads.
  expect(html).toMatch(
    /data-testid="pages-default-barrel" data-unused-loaded="false"[^>]*>default-used</,
  );
});
