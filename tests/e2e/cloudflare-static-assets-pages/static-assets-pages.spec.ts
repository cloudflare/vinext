import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Local runs build both examples; deployed runs target each PR's preview.
const deployed = Boolean(process.env.VINEXT_E2E_BASE_URL);
const i18nBaseURL = process.env.VINEXT_E2E_I18N_BASE_URL ?? "http://localhost:4219";
if (deployed && !process.env.VINEXT_E2E_I18N_BASE_URL) {
  throw new Error("VINEXT_E2E_I18N_BASE_URL is required with VINEXT_E2E_BASE_URL");
}
const cacheDir = path.resolve("examples/static-assets-pages/dist/client/_vinext/static-cache");
const prerenderManifestPath = path.resolve(
  "examples/static-assets-pages/dist/server/vinext-prerender.json",
);

/** index.json is always packaged; deployed runs cannot list the remaining ids. */
function listArtifacts(): string[] {
  return deployed ? ["index.json"] : fs.readdirSync(cacheDir);
}

/** Read the build ID from a page, so deployed runs need no local build output. */
async function readBuildId(request: APIRequestContext, url: string): Promise<string> {
  const buildId = /"buildId":"([^"]+)"/.exec(await (await request.get(url)).text())?.[1];
  if (!buildId) throw new Error(`No buildId in ${url}`);
  return buildId;
}

function expectHit(response: APIResponse) {
  expect(response.status()).toBe(200);
  expect(response.headers()["x-vinext-cache"]).toBe("HIT");
}

// Next.js stores and serves both HTML and page data for prerendered Pages routes:
// https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
test("prerendered Pages HTML and navigation JSON are build-time cache hits", async ({
  request,
}) => {
  const buildId = await readBuildId(request, "/");
  for (const pathname of [
    "/posts/first",
    "/posts/second",
    "/posts/caf%C3%A9",
    "/posts/with%20space",
  ]) {
    const response = await request.get(`${pathname}?source=first`);
    expectHit(response);
    const html = await response.text();
    expect(html).toContain('id="render-source">build-time</p>');
    const data = await request.get(`/_next/data/${buildId}${pathname}.json?source=second`);
    expectHit(data);
    const props = await data.json();
    expect(props.pageProps.source).toBe("build-time");
    expect(html).toContain(props.pageProps.generation);
  }
});

test("automatically static pages are served from the packaged HTML", async ({ request }) => {
  for (const suffix of ["", "?source=nav"]) {
    const response = await request.get(`/${suffix}`);
    expectHit(response);
    expect(await response.text()).toContain('id="render-source">build-time</p>');
  }
});

test("cached pages preserve Document status and content type without replaying cookies", async ({
  request,
}) => {
  const response = await request.get("/accepted");
  expect(response.status()).toBe(202);
  expect(response.headers()["x-vinext-cache"]).toBe("HIT");
  expect(response.headers()["content-type"]).toBe("application/xhtml+xml; charset=utf-8");
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect(await response.text()).toContain("Accepted static page");
});

test("client navigation reuses build-time page data without a document reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => {
    const router = window.next?.router;
    return router && "isReady" in router && router.isReady;
  });
  await page.evaluate(() => Reflect.set(window, "__staticAssetsNoReload", true));
  const dataResponse = page.waitForResponse((response) =>
    /\/_next\/data\/[^/]+\/posts\/first\.json/.test(response.url()),
  );
  await page.getByRole("link", { name: "First post" }).click();
  expect((await dataResponse).headers()["x-vinext-cache"]).toBe("HIT");
  await expect(page.locator("#render-source")).toHaveText("build-time");
  await expect(page.getByRole("heading", { name: "Post: first" })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__staticAssetsNoReload"))).toBe(true);
});

test("finite ISR and on-demand revalidation leave the packaged snapshot unchanged", async ({
  request,
}) => {
  const initial = await request.get("/posts/first");
  expectHit(initial);
  const snapshot = await initial.text();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  // Deployed builds compile the revalidation control to a 404.
  expect((await request.get("/api/revalidate")).status()).toBe(deployed ? 404 : 200);
  const response = await request.get("/posts/first");
  expectHit(response);
  expect(await response.text()).toBe(snapshot);
  // This path list exists only at build time. Its finite TTL must not turn
  // immutable packaged entries into misses that rerun runtime getStaticPaths.
  const buildOnly = await request.get(`${i18nBaseURL}/fr/posts/first/`);
  expectHit(buildOnly);
  expect(await buildOnly.text()).toContain('id="render-source">build-time</p>');
});

test("conditional rewrites taken at build time do not freeze another page", async ({ request }) => {
  const anonymous = await request.get("/account");
  expectHit(anonymous);
  expect(await anonymous.text()).toContain("Static Assets Pages Router");
  const signedIn = await request.get("/account", { headers: { Cookie: "session=1" } });
  expect(signedIn.status()).toBe(200);
  expect(signedIn.headers()["x-vinext-cache"]).not.toBe("HIT");
  const html = await signedIn.text();
  expect(html).toContain("<h1>Account</h1>");
  expect(html).toContain('id="render-source">runtime</p>');
});

test("conditional rewrites to API routes at build time do not freeze the page", async ({
  request,
}) => {
  if (!deployed) {
    const manifest = JSON.parse(fs.readFileSync(prerenderManifestPath, "utf8")) as {
      routes: Array<{ route: string; status: string }>;
    };
    expect(manifest.routes.find((route) => route.route === "/billing")?.status).toBe("skipped");
  }
  const anonymous = await request.get("/billing");
  expect(anonymous.status()).toBe(200);
  expect(await anonymous.json()).toEqual({ viewer: "anonymous" });
  const signedIn = await request.get("/billing", { headers: { Cookie: "session=1" } });
  expect(signedIn.status()).toBe(200);
  expect(signedIn.headers()["x-vinext-cache"]).not.toBe("HIT");
  const html = await signedIn.text();
  expect(html).toContain("<h1>Billing</h1>");
  expect(html).toContain('id="render-source">runtime</p>');
});

test("SSR and unlisted fallback paths render at runtime without being persisted", async ({
  request,
}) => {
  for (const pathname of ["/dynamic", "/posts/unlisted"]) {
    const first = await request.get(pathname);
    const second = await request.get(pathname);
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);
    expect(first.headers()["x-vinext-cache"]).not.toBe("HIT");
    expect(second.headers()["x-vinext-cache"]).not.toBe("HIT");
    expect(await second.text()).not.toBe(await first.text());
  }
});

test("preview bypasses the prerendered page", async ({ request }) => {
  if (deployed) {
    expect((await request.get("/api/preview")).status()).toBe(404);
    test.skip(true, "deployed builds do not expose the preview control");
  }
  expect((await request.get("/api/preview")).status()).toBe(200);
  const response = await request.get("/posts/first");
  expect(response.status()).toBe(200);
  expect(response.headers()["x-vinext-cache"]).not.toBe("HIT");
  expect(await response.text()).toContain('id="render-source">preview</p>');
});

// https://github.com/vercel/next.js/blob/canary/test/e2e/500-page/500-page-build.test.ts
test("a prerendered custom 500 preserves the server error status", async ({ request }) => {
  for (const pathname of ["/dynamic?fail=1", "/500"]) {
    const response = await request.get(pathname);
    expect(response.status()).toBe(500);
    expect(response.headers()["x-vinext-cache"]).toBe("HIT");
    const html = await response.text();
    expect(html).toContain("Static Assets server error");
    expect(html).toContain('id="render-source">build-time</p>');
  }
});

test("a prerendered 404 retains source response cookies without persisting them", async ({
  request,
}) => {
  const response = await request.get("/dynamic?missing=1");
  expect(response.status()).toBe(404);
  expect(response.headers()["x-vinext-cache"]).toBe("HIT");
  expect(response.headers()["set-cookie"]).toContain("session=expired");
  expect(response.headers()["x-not-found-source"]).toBe("dynamic-page");
  expect(await response.text()).toContain('id="render-source">build-time</p>');

  const other = await request.get("/missing-page");
  expect(other.status()).toBe(404);
  expect(other.headers()["set-cookie"]).toBeUndefined();
  expect(other.headers()["x-not-found-source"]).toBeUndefined();
});

test("private artifacts remain inaccessible and the custom 404 keeps its status", async ({
  request,
}) => {
  const artifacts = listArtifacts();
  expect(artifacts).toContain("index.json");
  for (const artifact of artifacts) {
    const response = await request.get(`/_vinext/static-cache/${artifact}`);
    expect(response.status(), artifact).toBe(404);
  }
  const missing = await request.get("/missing-page");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["x-vinext-cache"]).toBe("HIT");
  const html = await missing.text();
  expect(html).toContain("Static Assets page not found");
  expect(html).toContain('id="render-source">build-time</p>');
});

// Next.js keeps the prerendered not-found document separate from runtime errors.
// https://github.com/vercel/next.js/blob/canary/test/e2e/500-page/500-page-build.test.ts
test("custom _error uses its 404 snapshot without reusing it for server errors", async ({
  request,
}) => {
  const missing = await request.get(`${i18nBaseURL}/missing`);
  expect(missing.status()).toBe(404);
  expect(missing.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await missing.text()).toContain('id="render-source">build-time</p>');

  const failure = await request.get(`${i18nBaseURL}/dynamic?fail=1`);
  expect(failure.status()).toBe(500);
  expect(failure.headers()["x-vinext-cache"]).not.toBe("HIT");
  expect(await failure.text()).toContain('id="render-source">runtime</p>');
});

// Domain contexts can change defaultLocale and generated links even for the
// same locale. Generic build snapshots must not be aliased across domains.
test("i18n domains render their own context instead of a locale-only snapshot", async ({
  request,
}) => {
  test.skip(deployed, "workers.dev routing cannot receive the configured i18n domain hosts");
  for (const [host, defaultLocale] of [
    ["en.example", "en"],
    ["fr.example", "fr"],
  ]) {
    const response = await request.get(`${i18nBaseURL}/en`, { headers: { Host: host } });
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vinext-cache"]).not.toBe("HIT");
    const html = await response.text();
    expect(html).toContain('id="locale">en</p>');
    expect(html).toContain(`id="default-locale">${defaultLocale}</p>`);
  }
});

// Next.js caches terminal GSP results, including redirect props and null notFound entries.
// https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
test("build-time redirects stay immutable for HTML and data", async ({ request }) => {
  const buildId = await readBuildId(request, "/");
  const redirect = await request.get("/redirect", { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expect(redirect.headers()["location"]).toBe("/posts/first?from=build");
  expect(redirect.headers()["x-vinext-cache"]).toBe("HIT");
  const data = await request.get(`/_next/data/${buildId}/redirect.json`);
  expectHit(data);
  expect(await data.json()).toMatchObject({
    pageProps: {
      __N_REDIRECT: "/posts/first?from=build",
      __N_REDIRECT_STATUS: 307,
    },
  });
});

test("build-time notFound results stay immutable for HTML and data", async ({ request }) => {
  const buildId = await readBuildId(request, "/");
  const removed = await request.get("/removed");
  expect(removed.status()).toBe(404);
  expect(removed.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await removed.text()).toContain("Static Assets page not found");
  const removedData = await request.get(`/_next/data/${buildId}/removed.json`);
  expect(removedData.status()).toBe(404);
  expect(removedData.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await removedData.json()).toEqual({ notFound: true });
});

test("locale-prefixed static pages and getStaticPaths variants use their build snapshots", async ({
  request,
}) => {
  const buildId = await readBuildId(request, `${i18nBaseURL}/`);
  for (const pathname of ["/fr", "/fr/posts/first", "/fr/posts/string", "/fr/posts/french-only"]) {
    const response = await request.get(`${i18nBaseURL}${pathname}`);
    expectHit(response);
    expect(await response.text()).toContain('id="locale">fr</p>');
  }
  const data = await request.get(`${i18nBaseURL}/_next/data/${buildId}/fr/posts/first.json`);
  expectHit(data);
  expect(await data.json()).toMatchObject({ pageProps: { locale: "fr", source: "build-time" } });
  // The snapshot cannot carry a request nonce, but still admits the build-only path.
  const nonced = await request.get(`${i18nBaseURL}/fr/posts/first`, {
    headers: { "Content-Security-Policy": "script-src 'nonce-e2e-nonce'" },
  });
  expect(nonced.status()).toBe(200);
  expect(nonced.headers()["x-vinext-cache"]).not.toBe("HIT");
  expect(await nonced.text()).toContain('nonce="e2e-nonce"');
  const unlistedLocale = await request.get(`${i18nBaseURL}/posts/french-only`);
  expect(unlistedLocale.status()).toBe(404);
  const missing = await request.get(`${i18nBaseURL}/fr/missing`);
  expect(missing.status()).toBe(404);
  expect(missing.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await missing.text()).toContain('id="render-source">build-time</p>');
});

test("cached internal redirects preserve client navigation", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => {
    const router = window.next?.router;
    return router && "isReady" in router && router.isReady;
  });
  await page.evaluate(() => Reflect.set(window, "__redirectNoReload", true));
  await page.evaluate(async () => {
    const router = window.next?.router;
    if (!router || !("push" in router)) throw new Error("Pages router is not ready");
    await router.push("/redirect");
  });
  await expect(page).toHaveURL(/\/posts\/first\?from=build$/);
  await expect(page.locator("#render-source")).toHaveText("build-time");
  expect(await page.evaluate(() => Reflect.get(window, "__redirectNoReload"))).toBe(true);
});

// Ported from Next.js: test/e2e/prerender.test.ts (encoded paths)
// https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
test("equivalent encodings hit the same snapshot while escaped delimiters stay distinct", async ({
  request,
}) => {
  const buildId = await readBuildId(request, "/");
  for (const [slug, encodings] of [
    ["first", ["first", "%66irst"]],
    ["café", ["caf%C3%A9", "caf%c3%a9"]],
    ["a/b", ["a%2Fb", "a%2fb"]],
    ["a%2Fb", ["a%252Fb"]],
    ["a?b", ["a%3Fb"]],
    ["a#b", ["a%23b"]],
    ["a\\b", ["a%5Cb"]],
    ["%66irst", ["%2566irst"]],
  ] as const) {
    let generation: string | undefined;
    for (const encoded of encodings) {
      const html = await request.get(`/posts/${encoded}`);
      expectHit(html);
      const data = await request.get(`/_next/data/${buildId}/posts/${encoded}.json`);
      expectHit(data);
      const props = (await data.json()).pageProps;
      expect(props.slug).toBe(slug);
      expect(props.source).toBe("build-time");
      expect(await html.text()).toContain(props.generation);
      if (generation) expect(props.generation).toBe(generation);
      generation = props.generation;
    }
  }
});

test("default-locale paths named after locales keep their own terminal snapshots", async ({
  request,
}) => {
  const buildId = await readBuildId(request, `${i18nBaseURL}/`);
  const redirect = await request.get(`${i18nBaseURL}/en/fr/`, { maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expect(redirect.headers()["location"]).toBe("/posts/first/?from=default-fr");
  expect(redirect.headers()["x-vinext-cache"]).toBe("HIT");
  const data = await request.get(`${i18nBaseURL}/_next/data/${buildId}/en/fr.json`);
  expectHit(data);
  expect((await data.json()).pageProps.__N_REDIRECT).toBe("/posts/first/?from=default-fr");
  const notFound = await request.get(`${i18nBaseURL}/_next/data/${buildId}/en/en.json`);
  expect(notFound.status()).toBe(404);
  expect(notFound.headers()["x-vinext-cache"]).toBe("HIT");
  expect(await notFound.json()).toEqual({ notFound: true });
  const frenchRoot = await request.get(`${i18nBaseURL}/fr/`);
  expectHit(frenchRoot);
  expect(await frenchRoot.text()).toContain('id="locale">fr</p>');
});

test("locale snapshots share encoded and trailing-slash request identities", async ({
  request,
}) => {
  const buildId = await readBuildId(request, `${i18nBaseURL}/`);
  for (const prefix of ["", "/en", "/fr"]) {
    for (const slug of ["first", "%66irst"]) {
      const response = await request.get(`${i18nBaseURL}${prefix}/posts/${slug}/`);
      expectHit(response);
      expect(await response.text()).toContain('id="render-source">build-time</p>');
      const data = await request.get(
        `${i18nBaseURL}/_next/data/${buildId}${prefix}/posts/${slug}.json`,
      );
      expectHit(data);
      expect((await data.json()).pageProps.locale).toBe(prefix === "/fr" ? "fr" : "en");
    }
  }
});

test("rewrites serve public assets but cannot expose private cache artifacts", async ({
  request,
}) => {
  const artifacts = listArtifacts();
  for (const phase of ["before", "after", "fallback"]) {
    for (const [pathname, body] of [
      ["visible.txt", "Public fixture asset\n"],
      ["%76isible.txt", "Public fixture asset\n"],
      ["caf%c3%a9.txt", "Unicode public fixture asset\n"],
    ]) {
      const publicAsset = await request.get(`/${phase}/${pathname}`);
      expect(publicAsset.status()).toBe(200);
      expect(await publicAsset.text()).toBe(body);
    }
    for (const artifact of artifacts) {
      for (const directory of ["_vinext", "%5fvinext"]) {
        const response = await request.get(`/${phase}/${directory}/static-cache/${artifact}`);
        expect(response.status(), `${phase}/${directory}/${artifact}`).toBe(404);
      }
    }
  }
});
