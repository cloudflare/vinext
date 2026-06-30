import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4179";

test("starts with next/link while API instrumentation stays server-only", async ({ request }) => {
  const pageResponse = await request.get(`${BASE}/`);
  expect(pageResponse.status()).toBe(200);
  expect(await pageResponse.text()).toContain("Cloudflare Pages Router");

  const instrumentationResponse = await request.get(`${BASE}/api/instrumentation-test`);
  expect(instrumentationResponse.status()).toBe(200);
  expect(await instrumentationResponse.json()).toMatchObject({ registerCalled: true });
});
