import { expect, test } from "@playwright/test";
import { request as httpRequest } from "node:http";

function getRawPath(path: string): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4191 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ body, status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("double-encoded static paths are not decoded twice", async ({ request }) => {
  const direct = await request.get("/admin");
  expect(direct.status()).toBe(403);

  const response = await request.get("/%2561dmin");
  expect(response.status()).toBe(404);
  expect(await response.text()).not.toContain("Protected admin content");

  const repeatedlyEncoded = await getRawPath("/%252561dmin");
  expect(repeatedlyEncoded.status).toBe(404);
  expect(repeatedlyEncoded.body).not.toContain("Protected admin content");

  const encodedStatic = await getRawPath("/%61dmin");
  expect(encodedStatic.status).toBe(404);
  expect(encodedStatic.body).not.toContain("Protected admin content");
});

test("server action rerenders preserve encoded request route identity", async ({ page }) => {
  await page.goto("/nextjs-compat/action-revalidate");
  await expect(page.locator("#revalidate")).toBeVisible();
  await page.evaluate(() => history.pushState(null, "", "/%2561dmin"));

  const actionResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST",
  );
  await page.locator("#revalidate").click();
  const actionResponse = await actionResponsePromise;

  expect(new URL(actionResponse.url()).pathname).toBe("/%2561dmin");
  expect(await actionResponse.text()).not.toContain("Protected admin content");
});

for (const pathname of ["/foo/..%252fadmin", "/api/health/..%252fadmin"]) {
  test(`keeps encoded delimiters non-structural for ${pathname}`, async ({ request }) => {
    const response = await request.get(pathname);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain("Protected admin content");
  });
}
