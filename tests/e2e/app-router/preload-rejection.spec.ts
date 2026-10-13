import { expect, test } from "@playwright/test";

// Next.js's router server logs uncaught exceptions and unhandled rejections and
// keeps serving, in both `next dev` and `next start`
// (packages/next/src/server/lib/router-server.ts, `logError`). A page that
// leaves a rejection unhandled for a few ticks, as the documented preload
// pattern does for an unknown id, must not take down the server. Runs against
// the dev server and, via app-router-isr-prod, `vinext start`.
test("keeps serving after a page leaves a rejection unhandled", async ({ request }) => {
  const missing = await request.get("/preload-rejection/missing");
  expect(missing.status()).toBe(404);

  const found = await request.get("/preload-rejection/1");
  expect(found.status()).toBe(200);
  expect(await found.text()).toContain("Item 1");
});
