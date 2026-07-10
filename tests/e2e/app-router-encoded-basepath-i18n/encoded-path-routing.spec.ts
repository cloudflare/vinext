import { expect, test } from "@playwright/test";
import { request as httpRequest } from "node:http";

function getRawPath(path: string): Promise<{ body: string; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4196 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          body,
          location: Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location,
          status: res.statusCode ?? 0,
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("preserves encoded params through basePath and default-locale rewrites", async ({
  request,
}) => {
  for (const pathname of [
    "/docs/encoded-parity/page/a%2561/b%2Fc",
    "/docs/encoded-parity/rewrite/a%2561/b%2Fc",
    "/docs/encoded-parity/middleware/a%2561/b%2Fc",
  ]) {
    const response = await request.get(pathname);
    expect(response.status(), pathname).toBe(200);
    expect(await response.text()).toContain('["a%2561","b%2Fc"]');
  }
});

test("decodes lazy Route Handler params once behind basePath and i18n", async ({ request }) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request.get("/docs/encoded-parity/handler/a%2561/b%2Fc");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ path: ["a%61", "b/c"] });
  }
});

test("keeps encoded static values distinct behind basePath and i18n", async () => {
  const allowed = await getRawPath("/docs/encoded-parity/static/a%252Fb");
  expect(allowed.status).toBe(200);
  expect(allowed.body).toContain("a%252Fb");

  const alias = await getRawPath("/docs/encoded-parity/static/a%2Fb");
  expect(alias.status).toBe(404);
});

test("honors encoded middleware rewrites behind basePath and i18n", async () => {
  const response = await getRawPath("/docs/%61dmin");
  expect(response.status).toBe(200);
  expect(response.body).toContain("Protected admin content");
});

test("keeps config source literals distinct behind basePath and i18n", async () => {
  const literalRewrite = await getRawPath("/docs/rewrite-about");
  expect(literalRewrite.status).toBe(200);
  expect(literalRewrite.body).toContain("About");

  const encodedRewrite = await getRawPath("/docs/%72ewrite-about");
  expect(encodedRewrite.status).toBe(404);
  expect(encodedRewrite.body).not.toContain("About");

  const literalRedirect = await getRawPath("/docs/old-about");
  expect(literalRedirect.status).toBe(308);
  expect(literalRedirect.location).toBe("/docs/about");

  const encodedRedirect = await getRawPath("/docs/%6Fld-about");
  expect(encodedRedirect.status).toBe(404);
  expect(encodedRedirect.location).toBeUndefined();
});

test("preserves raw redirect captures behind basePath and i18n", async () => {
  const response = await getRawPath("/docs/repeat-redirect/a%252Fb");

  expect(response.status).toBe(307);
  expect(response.location).toBe("/docs/blog/a%252Fb/a%252Fb");
});
