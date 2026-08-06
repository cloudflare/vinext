import { expect, test } from "@playwright/test";

test("hybrid Worker revalidation does not expose the Node logical-host side channel", async ({
  request,
}) => {
  const response = await request.get("http://localhost:4176/api/revalidate-side-channel");

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ revalidated: true });
});
