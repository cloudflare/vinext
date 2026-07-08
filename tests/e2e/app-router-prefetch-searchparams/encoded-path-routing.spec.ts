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

  const encodedStatic = await getRawPath("/%61dmin");
  expect(encodedStatic.status).toBe(404);
  expect(encodedStatic.body).not.toContain("Protected admin content");
});

for (const pathname of ["/foo/..%252fadmin", "/api/health/..%252fadmin"]) {
  test(`keeps encoded delimiters non-structural for ${pathname}`, async ({ request }) => {
    const response = await request.get(pathname);
    expect(response.status()).toBe(404);
    expect(await response.text()).not.toContain("Protected admin content");
  });
}
