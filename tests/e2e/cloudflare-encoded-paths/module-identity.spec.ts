import { expect, test } from "@playwright/test";

test("uses the deployed SSR module URL from the Workers module registry", async ({ request }) => {
  const response = await request.get("/module-identity");

  expect(response.status()).toBe(200);
  expect(await response.text()).toMatch(
    /Module URL: <!-- -->file:\/\/\/bundle\/ssr\/_next\/static\/module-url-[\w-]+\.js/,
  );
});
