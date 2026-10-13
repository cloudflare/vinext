import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4175";

// Next.js's router server logs uncaught exceptions and unhandled rejections and
// keeps serving (packages/next/src/server/lib/router-server.ts, `logError`).
// getServerSideProps leaving a rejection unhandled for a few ticks must not
// take down `vinext start`.
test("keeps serving after getServerSideProps leaves a rejection unhandled", async ({ request }) => {
  const missing = await request.get(`${BASE}/preload-rejection/missing`);
  expect(missing.status()).toBe(404);

  const found = await request.get(`${BASE}/preload-rejection/1`);
  expect(found.status()).toBe(200);
  expect(await found.text()).toContain("Item 1");
});
