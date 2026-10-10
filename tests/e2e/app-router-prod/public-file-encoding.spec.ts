import { expect, test } from "@playwright/test";

// Middleware matchers see the raw and once-decoded pathname. A public file must
// be reachable only at the path those matchers see, so a double-encoded alias
// cannot serve public/members only/confidential.txt past the scoped middleware.
test("does not serve a middleware-protected public file through a double-encoded alias", async ({
  request,
}) => {
  const direct = await request.get("/members%20only/confidential.txt");
  expect(direct.status()).toBe(403);
  expect(await direct.text()).toBe("blocked by middleware");

  const alias = await request.get("/members%2520only/confidential.txt");
  expect(alias.status()).toBe(404);
  expect(await alias.text()).not.toContain("members-only public file");
});
