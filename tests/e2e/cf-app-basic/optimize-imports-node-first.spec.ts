import { test, expect } from "@playwright/test";

// fake-node-first-barrel is in the fixture's optimizePackageImports. Like
// lucide-react, its exports list a "node" CommonJS entry before "import".
// The Workers SSR environment has no "node" condition and resolves the ESM
// entry, so the rewrite must read that barrel: its unused leaf is never
// evaluated.
test("optimizePackageImports reads the barrel entry Workers SSR resolves", async ({ request }) => {
  const res = await request.get("/optimize-imports-node-first");
  expect(res.status()).toBe(200);
  expect(await res.text()).toMatch(
    /data-testid="client-node-first" data-unused-loaded="false"[^>]*>node-first-used</,
  );
});
