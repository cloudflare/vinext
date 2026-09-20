import { expect, test } from "@playwright/test";

test("starts with the self-contained Response Store", async ({ request }) => {
  const response = await request.get("/");

  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("vinext on Cloudflare Workers");
});
