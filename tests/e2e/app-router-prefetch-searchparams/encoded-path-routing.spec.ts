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

  const encodedStatic = await getRawPath("/%61bout");
  expect(encodedStatic.status).toBe(404);
  expect(encodedStatic.body).not.toContain("About");
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

test("keeps lazy Route Handler params stable across first and later production requests", async ({
  request,
}) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request.get("/encoded-parity/handler/a%2561/b%2Fc");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ path: ["a%61", "b/c"] });
  }

  const optional = await request.get("/encoded-parity/handler");
  expect(await optional.json()).toEqual({ path: null });
});

test("keeps direct and rewritten production App Page params canonical", async ({ request }) => {
  for (const pathname of [
    "/encoded-parity/page/a%2561/b%2Fc",
    "/encoded-parity/rewrite/a%2561/b%2Fc",
    "/encoded-parity/middleware/a%2561/b%2Fc",
  ]) {
    const response = await request.get(pathname);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('["a%2561","b%2Fc"]');
  }
});

test("enforces canonical dynamicParams=false values in production", async () => {
  const allowed = await getRawPath("/encoded-parity/static/a%252Fb");
  expect(allowed.status).toBe(200);
  expect(allowed.body).toContain("a%252Fb");

  const alias = await getRawPath("/encoded-parity/static/a%2Fb");
  expect(alias.status).toBe(404);
});

test("honors normalized-equal middleware destinations in production", async () => {
  const response = await getRawPath("/%61dmin");
  expect(response.status).toBe(200);
  expect(response.body).toContain("Protected admin content");
});
