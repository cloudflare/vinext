import { expect, test } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

const PORT = 4175;

function getRawPath(
  path: string,
): Promise<{ body: string; headers: IncomingHttpHeaders; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: PORT }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({
          body,
          headers: res.headers,
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

test("keeps raw Pages route, middleware, slash, and header identity in production", async () => {
  const literal = await getRawPath("/about");
  expect(literal.status).toBe(200);
  expect(literal.headers["x-page-header"]).toBe("about-page");

  const alias = await getRawPath("/%61bout");
  expect(alias.status).toBe(404);
  expect(alias.body).not.toContain("About");
  expect(alias.headers["x-mw-pathname"]).toBe("/%61bout");
  expect(alias.headers["x-page-header"]).toBeUndefined();

  const slash = await getRawPath("/%61bout/");
  expect(slash.status).toBe(308);
  expect(slash.location).toBe("/%61bout");
});

test("canonicalizes WHATWG dot segments before Pages production routing and config", async () => {
  const page = await getRawPath("/%2e/about");
  expect(page.status).toBe(200);
  expect(page.headers["x-mw-pathname"]).toBe("/about");
  expect(page.headers["x-page-header"]).toBe("about-page");
  expect(page.body).toContain("About");

  const redirect = await getRawPath("/x/%2e%2e/old-about");
  expect(redirect.status).toBe(308);
  expect(redirect.location).toBe("/about");

  const rewrite = await getRawPath("/x/%2e%2e/before-rewrite");
  expect(rewrite.status).toBe(200);
  expect(rewrite.body).toContain("About");

  for (const escapedDelimiter of ["%2f", "%5c", "%252f"]) {
    expect((await getRawPath(`/x/${escapedDelimiter}/about`)).status).toBe(404);
  }
});

test("decodes Pages dynamic params exactly once in production", async () => {
  const encodedPercent = await getRawPath("/posts/a%2561");
  expect(encodedPercent.status).toBe(200);
  expect(encodedPercent.body).toMatch(/Post: (?:<!-- -->)?a%61/);

  const encodedSlash = await getRawPath("/posts/b%2Fc");
  expect(encodedSlash.status).toBe(200);
  expect(encodedSlash.body).toMatch(/Post: (?:<!-- -->)?b\/c/);
});
