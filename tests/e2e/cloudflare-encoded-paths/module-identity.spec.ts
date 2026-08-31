import { expect, test } from "@playwright/test";

// Regression: https://github.com/cloudflare/vinext/issues/3006
test("evaluates URL-only SSR chunks without process.cwd", async ({ request }) => {
  const response = await request.get("/module-identity");

  expect(response.status()).toBe(200);
  expect(await response.text()).toMatch(
    /Module URL: <!-- -->file:\/\/\/ssr\/_next\/static\/module-url-[\w-]+\.js/,
  );
});
