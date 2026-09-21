/**
 * Ported from Next.js: test/e2e/on-request-error/otel/otel.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/on-request-error/otel/otel.test.ts
 */

import { expect, test } from "@playwright/test";

test("@vercel/otel records a span before the first request", async ({ request }) => {
  const response = await request.get("/api/instrumentation-test");
  expect(response.status()).toBe(200);

  const data = await response.json();
  expect(
    data.spans.find((span: { name: string }) => span.name === "vinext.otel.registration"),
  ).toMatchObject({
    name: "vinext.otel.registration",
    serviceName: "vinext-app-router-cloudflare",
    spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
  });
});
