import { expect, test } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

function getRawPath(
  path: string,
): Promise<{ body: string; headers: IncomingHttpHeaders; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4197 }, (res) => {
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

test("keeps lazy Route Handler params stable across first and later Worker requests", async ({
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

test("keeps direct and middleware-rewritten Worker App Page params canonical", async ({
  request,
}) => {
  for (const pathname of [
    "/encoded-parity/page/a%2561/b%2Fc",
    "/encoded-parity/rewrite/a%2561/b%2Fc",
  ]) {
    const response = await request.get(pathname);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('["a%2561","b%2Fc"]');
  }
});

test("enforces canonical dynamicParams=false values on Workers", async () => {
  const allowed = await getRawPath("/encoded-parity/static/a%252Fb");
  expect(allowed.status).toBe(200);
  expect(allowed.body).toContain("a%252Fb");

  const alias = await getRawPath("/encoded-parity/static/a%2Fb");
  expect(alias.status).toBe(404);
});

test("honors explicit normalized-equal Worker middleware rewrites", async () => {
  const implicitAlias = await getRawPath("/%61bout");
  expect(implicitAlias.status).toBe(404);

  const rewritten = await getRawPath("/%61dmin");
  expect(rewritten.status).toBe(200);
  expect(rewritten.body).toContain("Worker admin content");
});

test("keeps Worker encoded aliases out of slash and config-header identity", async () => {
  const literal = await getRawPath("/about");
  expect(literal.status).toBe(200);
  expect(literal.headers["x-page-header"]).toBe("about-page");

  const alias = await getRawPath("/%61bout");
  expect(alias.status).toBe(404);
  expect(alias.headers["x-page-header"]).toBeUndefined();

  const slash = await getRawPath("/%61bout/");
  expect(slash.status).toBe(308);
  expect(slash.location).toBe("/%61bout");
});

test("canonicalizes WHATWG dot segments before App Worker routing and config", async () => {
  const page = await getRawPath("/%2e/about");
  expect(page.status).toBe(200);
  expect(page.headers["x-page-header"]).toBe("about-page");
  expect(page.body).toContain("About");

  const redirect = await getRawPath("/x/%2e%2e/old-about");
  expect(redirect.status).toBe(308);
  expect(redirect.location).toBe("/about");

  const rewrite = await getRawPath("/x/%2e%2e/rewrite-about");
  expect(rewrite.status).toBe(200);
  expect(rewrite.body).toContain("About");

  for (const escapedDelimiter of ["%2f", "%5c", "%252f"]) {
    expect((await getRawPath(`/x/${escapedDelimiter}/about`)).status).toBe(404);
  }
});

test("keeps Worker config source literals distinct from percent-encoded aliases", async () => {
  const literalRewrite = await getRawPath("/rewrite-about");
  expect(literalRewrite.status).toBe(200);
  expect(literalRewrite.body).toContain("About");

  const encodedRewrite = await getRawPath("/%72ewrite-about");
  expect(encodedRewrite.status).toBe(404);
  expect(encodedRewrite.body).not.toContain("About");

  const literalRedirect = await getRawPath("/old-about");
  expect(literalRedirect.status).toBe(308);
  expect(literalRedirect.location).toBe("/about");

  const encodedRedirect = await getRawPath("/%6Fld-about");
  expect(encodedRedirect.status).toBe(404);
  expect(encodedRedirect.location).toBeUndefined();
});

test("preserves raw redirect captures on Workers", async () => {
  const response = await getRawPath("/repeat-redirect/a%252Fb");

  expect(response.status).toBe(307);
  expect(response.location).toBe("/blog/a%252Fb/a%252Fb");
});
