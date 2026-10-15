import { expect, test } from "@playwright/test";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { waitForAppRouterHydration } from "../helpers";

function getRawPath(
  path: string,
): Promise<{ body: string; headers: IncomingHttpHeaders; location?: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "localhost", path, port: 4196 }, (res) => {
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

test("keeps encoded aliases out of slash and config-header identity behind basePath", async () => {
  const literal = await getRawPath("/docs/about");
  expect(literal.status).toBe(200);
  expect(literal.headers["x-page-header"]).toBe("about-page");

  const alias = await getRawPath("/docs/%61bout");
  expect(alias.status).toBe(404);
  expect(alias.headers["x-page-header"]).toBeUndefined();

  const slash = await getRawPath("/docs/%61bout/");
  expect(slash.status).toBe(308);
  expect(slash.location).toBe("/docs/%61bout");
});

test("canonicalizes dot segments before App basePath, i18n, and config handling", async () => {
  const page = await getRawPath("/docs/%2e/about");
  expect(page.status).toBe(200);
  expect(page.headers["x-page-header"]).toBe("about-page");
  expect(page.body).toContain("About");

  const redirect = await getRawPath("/docs/x/%2e%2e/old-about");
  expect(redirect.status).toBe(308);
  expect(redirect.location).toBe("/docs/about");

  const rewrite = await getRawPath("/docs/x/%2e%2e/rewrite-about");
  expect(rewrite.status).toBe(200);
  expect(rewrite.body).toContain("About");

  const outside = await getRawPath("/docs/%2e%2e/about");
  expect(outside.status).toBe(404);

  for (const escapedDelimiter of ["%2f", "%5c", "%252f"]) {
    expect((await getRawPath(`/docs/x/${escapedDelimiter}/about`)).status).toBe(404);
  }
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

test("runs an action redirect rewrite through the full pipeline behind basePath", async ({
  page,
}) => {
  await page.goto("/docs/nextjs-compat/action-redirect-middleware");
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    Reflect.set(window, "__ACTION_REDIRECT_BASEPATH_DOCUMENT__", "preserved");
  });

  await page.click("#redirect-to-middleware-rewrite");

  await expect(page).toHaveURL(/\/docs\/middleware-rewrite$/);
  await expect(page.getByText("Welcome to App Router", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "__ACTION_REDIRECT_BASEPATH_DOCUMENT__")),
  ).toBe("preserved");

  await page.goto("/docs/nextjs-compat/action-redirect-middleware");
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    Reflect.set(window, "__ACTION_REDIRECT_BASEPATH_DOCUMENT__", "preserved");
  });
  await page.click("#redirect-to-config-redirect");

  await expect(page).toHaveURL(/\/docs\/redirect-test-config$/);
  await expect(page.getByText("About", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "__ACTION_REDIRECT_BASEPATH_DOCUMENT__")),
  ).toBe("preserved");
});

// Next.js reads the Pages locale from the raw pathname, so `/%66r/...` names no
// locale: it 404s instead of reaching the `fr` page that middleware never ran
// for. Static Pages segments keep the same raw identity.
test("keeps encoded locale and static Pages aliases out of hybrid Pages routing", async () => {
  const literal = await getRawPath("/docs/fr/pages-script-manual-nonce");
  expect(literal.status).toBe(200);
  expect(literal.headers["x-mw-ran"]).toBe("true");
  expect(literal.body).toContain("<p>script-nonce</p>");

  for (const pathname of [
    "/docs/%66r/pages-script-manual-nonce",
    "/docs/%2566r/pages-script-manual-nonce",
    "/docs/%70ages-script-manual-nonce",
    "/docs/fr/%70ages-script-manual-nonce",
  ]) {
    const alias = await getRawPath(pathname);
    expect(alias.status, pathname).toBe(404);
    expect(alias.body, pathname).not.toContain("<p>script-nonce</p>");
  }
});

test("decodes hybrid Pages params once behind basePath and i18n", async () => {
  for (const pathname of ["/docs/pages-to-app/a%2561", "/docs/fr/pages-to-app/a%2561"]) {
    const response = await getRawPath(pathname);
    expect(response.status, pathname).toBe(200);
    expect(response.body, pathname).toContain('"slug":"a%61"');
  }
});

// Next.js parses every rewrite destination as a URL, so a literal `é` reaches
// the Pages router as `%C3%A9`: the static `encoded-parity-café` page 404s in
// every phase, while a dynamic capture decodes once back to `café`.
test("serializes hybrid Pages rewrite destinations in every rewrite phase", async () => {
  for (const phase of ["before", "after", "fallback"]) {
    const staticPage = await getRawPath(`/docs/encoded-parity-pages/${phase}`);
    expect(staticPage.status, phase).toBe(404);
    expect(staticPage.body, phase).not.toContain("encoded-parity-cafe");

    const dynamicPage = await getRawPath(`/docs/encoded-parity-pages/${phase}-dynamic`);
    expect(dynamicPage.status, phase).toBe(200);
    expect(dynamicPage.body, phase).toContain('"slug":"café"');

    // Only the destination template is URL-parsed, so a captured `..` is not
    // resolved into a route the middleware matcher never saw.
    const capture = (n: string) =>
      getRawPath(`/docs/encoded-parity-pages/${phase}-capture?n=${encodeURIComponent(n)}`);
    const dotCapture = await capture("../pages-script-manual-nonce");
    expect(dotCapture.status, phase).toBe(404);
    expect(dotCapture.body, phase).not.toContain("<p>script-nonce</p>");
    const valueCapture = await capture("café");
    expect(valueCapture.status, phase).toBe(200);
    expect(valueCapture.body, phase).toContain('"slug":"café"');
  }
});

test("does not report URL-parser encoding as a hybrid Pages data rewrite", async () => {
  const html = (await getRawPath("/docs/pages-to-app/x")).body;
  const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
  expect(buildId).toBeTruthy();

  for (const [slug, expected] of [
    ["caf%C3%A9", "café"],
    ["a%20b", "a b"],
  ]) {
    const response = await getRawPath(`/docs/_next/data/${buildId}/pages-to-app/${slug}.json`);
    expect(response.status, slug).toBe(200);
    expect(JSON.parse(response.body).pageProps, slug).toEqual({ params: { slug: expected } });
    expect(response.headers["x-nextjs-rewrite"], slug).toBeUndefined();
  }
});

// Next.js router-server.ts sends a hybrid app's data miss to the App not-found
// route: a 404 without the Pages-only JSON matched-path response.
test("answers a hybrid data miss with a 404", async () => {
  const html = (await getRawPath("/docs/pages-to-app/x")).body;
  const buildId = html.match(/"buildId":"([^"]+)"/)?.[1];
  expect(buildId).toBeTruthy();

  for (const page of ["encoded-parity-missing", "fr/encoded-parity-missing"]) {
    const response = await getRawPath(`/docs/_next/data/${buildId}/${page}.json`);
    expect(response.status, page).toBe(404);
    expect(response.headers["x-nextjs-matched-path"], page).toBeUndefined();
    expect(response.headers["cache-control"], page).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  }
});
