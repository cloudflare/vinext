import { expect, test } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

function getRawPath(
  path: string,
  headers?: Record<string, string>,
): Promise<{ body: string; headers: IncomingHttpHeaders; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4191, headers }, (res) => {
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

test("keeps encoded static aliases out of slash and config-header identity", async () => {
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

test("canonicalizes WHATWG dot segments before App production routing and config", async () => {
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

test("keeps config source literals distinct from percent-encoded aliases", async () => {
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

test("preserves every encoding layer in repeated config redirect captures", async () => {
  const response = await getRawPath("/repeat-redirect/a%252Fb");

  expect(response.status).toBe(307);
  expect(response.location).toBe("/blog/a%252Fb/a%252Fb");
});

// Next.js 16.2.7 answers an encoded static page pathname beside a dynamic
// sibling with the static page it prerendered, under the decoded pathname.
test("renders an encoded static page beside its dynamic sibling in production", async () => {
  for (const [pathname, headers] of [
    ["/encoded-parity/sibling/%6Eew", undefined],
    ["/encoded-parity/sibling/%6Eew?_rsc", { RSC: "1" }],
  ] as const) {
    const encoded = await getRawPath(pathname, headers);
    expect(encoded.status).toBe(200);
    expect(encoded.body).toContain("static sibling new");
    expect(encoded.body).not.toContain("dynamic sibling");
  }

  // The encoded request shares the static page's cache entry, never replaces it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const literal = await getRawPath("/encoded-parity/sibling/new");
    expect(literal.status).toBe(200);
    expect(literal.body).toContain("static sibling new");
    expect(literal.body).not.toContain("dynamic sibling");
  }
});

test("reaches a non-ASCII static page beside its dynamic sibling in production", async () => {
  for (const pathname of [
    "/encoded-parity/sibling/caf%C3%A9",
    "/encoded-parity/sibling/caf%c3%a9",
  ]) {
    const response = await getRawPath(pathname);
    expect(response.status).toBe(200);
    expect(response.body).toContain("static sibling café");
    expect(response.body).not.toContain("dynamic sibling");
  }
});

test("keeps raw routing where Next.js has no prerendered page to answer in production", async () => {
  // A force-dynamic page has no prerender, so its dynamic sibling renders.
  const forceDynamic = await getRawPath("/encoded-parity/sibling/%6Cive");
  expect(forceDynamic.status).toBe(200);
  expect(forceDynamic.body).toContain("dynamic sibling live");
  expect(forceDynamic.body).not.toContain("forced dynamic page");
  const forceDynamicLiteral = await getRawPath("/encoded-parity/sibling/live");
  expect(forceDynamicLiteral.body).toContain("forced dynamic page live");

  // Static segments below a dynamic parent compare against the raw path. The
  // dynamic render must stay out of the static route's cache entry.
  const encodedMember = await getRawPath("/encoded-parity/member/bob/%73ettings");
  expect(encodedMember.status).toBe(200);
  expect(encodedMember.body).toContain("tab settings for bob");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const literal = await getRawPath("/encoded-parity/member/bob/settings");
    expect(literal.status).toBe(200);
    expect(literal.body).toContain("settings for bob");
    expect(literal.body).not.toContain("tab settings");
  }
});
