import { expect, test } from "@playwright/test";

test("double-encoded static paths are not decoded twice", async ({ request }) => {
  const direct = await request.get("/admin");
  expect(direct.status()).toBe(403);

  const response = await request.get("/%2561dmin");
  expect(response.status()).toBe(404);
  expect(await response.text()).not.toContain("Protected admin content");
});

for (const pathname of ["/foo/..%252fadmin", "/api/health/..%252fadmin"]) {
  test(`keeps encoded delimiters non-structural for ${pathname}`, async ({ request }) => {
    const response = await request.get(pathname);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain("Protected admin content");
  });
}
