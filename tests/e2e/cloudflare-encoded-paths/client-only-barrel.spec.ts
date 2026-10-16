import { expect, test } from "@playwright/test";

// Regression: https://github.com/cloudflare/vinext/issues/4007
test("serves a Server Component that imports from a sideEffects:false barrel with a client-only leaf", async ({
  request,
}) => {
  const response = await request.get("/client-only-barrel");

  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("Server-safe barrel export");
});
