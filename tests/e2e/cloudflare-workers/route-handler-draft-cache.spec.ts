import { spawn, type ChildProcess } from "node:child_process";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../fixtures";
import { computeRscCacheBustingSearchParam } from "../../../packages/vinext/src/server/app-rsc-cache-busting";

const FIXTURE_DIR = `${process.cwd()}/tests/fixtures/cf-app-basic`;
const BASE_URL = "http://localhost:4195";

let server: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`cf-app-basic Worker exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for cf-app-basic Worker");
}

async function setDraftMode(request: APIRequestContext, enabled: boolean): Promise<void> {
  const response = await request.get(`${BASE_URL}/api/draft-${enabled ? "enable" : "disable"}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["cdn-cache-control"]).toBeUndefined();
  expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  expect(response.headers()["cache-tag"]).toBeUndefined();
}

async function readDraftIsrRoute(request: APIRequestContext, scenario: string) {
  const response = await request.get(`${BASE_URL}/api/draft-isr/${scenario}`);
  expect(response.status()).toBe(200);
  return {
    cacheControl: response.headers()["cache-control"],
    cacheTag: response.headers()["cache-tag"],
    cacheState: response.headers()["x-vinext-cache"],
    cdnCacheControl: response.headers()["cdn-cache-control"],
    payload: (await response.json()) as { draftMode: boolean; token: string },
  };
}

test.describe("Cloudflare route-handler draft-mode cache isolation", () => {
  test.beforeAll(async () => {
    server = spawn(
      "created_node_modules=0; if ! test -e node_modules && ! test -L node_modules; then ln -s ../../../node_modules node_modules; created_node_modules=1; fi; trap 'if test \"$created_node_modules\" = 1; then rm node_modules; fi' EXIT; ../../../node_modules/.bin/vp run vinext#build && VINEXT_TEST_CDN_CACHE=1 node ../../../packages/vinext/dist/cli.js build && npx wrangler dev --config dist/server/wrangler.json --port 4195",
      { cwd: FIXTURE_DIR, shell: true, stdio: "inherit" },
    );
    await waitForServer();
  });

  test.afterAll(() => {
    server.kill();
  });

  test("keeps draft and anonymous route-handler ISR responses isolated", async ({ request }) => {
    const forged = await request.get(`${BASE_URL}/api/draft-isr/forged-${Date.now()}`, {
      headers: { Cookie: "__prerender_bypass=forged" },
    });
    expect(forged.status()).toBe(200);
    expect(await forged.json()).toMatchObject({ draftMode: false });
    expect(forged.headers()["cache-control"]).toContain("no-store");
    expect(forged.headers()["cdn-cache-control"]).toBeUndefined();

    await setDraftMode(request, true);
    const draftFirstScenario = `draft-first-${Date.now()}`;
    const draftFirst = await readDraftIsrRoute(request, draftFirstScenario);
    await setDraftMode(request, false);
    const anonymousAfterDraft = await readDraftIsrRoute(request, draftFirstScenario);

    expect(draftFirst.payload.draftMode).toBe(true);
    expect(draftFirst.cacheState).not.toBe("HIT");
    expect(draftFirst.cacheControl).not.toContain("s-maxage");
    expect(draftFirst.cacheControl).toContain("no-store");
    expect(draftFirst.cdnCacheControl).toBeUndefined();
    expect(draftFirst.cacheTag).toBeUndefined();
    expect(anonymousAfterDraft.payload.draftMode).toBe(false);
    expect(anonymousAfterDraft.payload.token).not.toBe(draftFirst.payload.token);
    expect(anonymousAfterDraft.cacheControl).toContain("no-store");
    expect(anonymousAfterDraft.cdnCacheControl).toBeUndefined();

    const publicFirstScenario = `public-first-${Date.now()}`;
    const anonymousFirst = await readDraftIsrRoute(request, publicFirstScenario);
    expect(anonymousFirst.cacheControl).toContain("no-store");
    expect(anonymousFirst.cdnCacheControl).toBeUndefined();
    await setDraftMode(request, true);
    try {
      const draftAfterAnonymous = await readDraftIsrRoute(request, publicFirstScenario);
      expect(draftAfterAnonymous.payload.draftMode).toBe(true);
      expect(draftAfterAnonymous.payload.token).not.toBe(anonymousFirst.payload.token);
      expect(draftAfterAnonymous.cacheState).not.toBe("HIT");
      expect(draftAfterAnonymous.cacheControl).not.toContain("s-maxage");
      expect(draftAfterAnonymous.cacheControl).toContain("no-store");
      expect(draftAfterAnonymous.cdnCacheControl).toBeUndefined();
      expect(draftAfterAnonymous.cacheTag).toBeUndefined();
    } finally {
      await setDraftMode(request, false);
    }
  });

  test("keeps Authorization-bearing and anonymous route-handler ISR responses isolated", async ({
    request,
  }) => {
    const readScenario = async (scenario: string, authorization?: string) => {
      const response = await request.get(
        `${BASE_URL}/cdn-cache-isolation/${scenario}`,
        authorization ? { headers: { Authorization: authorization } } : undefined,
      );
      expect(response.status()).toBe(200);
      return {
        headers: response.headers(),
        payload: (await response.json()) as { draftMode: boolean; token: string },
      };
    };
    const expectAnonymousCachePolicy = (headers: Record<string, string>) => {
      expect(headers["cache-control"]).not.toContain("no-store");
      expect(headers["cdn-cache-control"]).toContain("max-age=");
      expect(headers.vary?.toLowerCase().split(/,\s*/)).toContain("authorization");
    };
    const expectAuthorizedNoStore = (headers: Record<string, string>) => {
      expect(headers["cache-control"]).toContain("no-store");
      expect(headers["cdn-cache-control"]).toBeUndefined();
      expect(headers["cloudflare-cdn-cache-control"]).toBeUndefined();
      expect(headers["cache-tag"]).toBeUndefined();
    };

    const authorizedFirstScenario = `authorized-first-${Date.now()}`;
    const authorizedFirst = await readScenario(authorizedFirstScenario, "Bearer user-a");
    const anonymousAfterAuthorized = await readScenario(authorizedFirstScenario);
    expectAuthorizedNoStore(authorizedFirst.headers);
    expectAnonymousCachePolicy(anonymousAfterAuthorized.headers);
    expect(anonymousAfterAuthorized.payload.token).not.toBe(authorizedFirst.payload.token);

    const anonymousFirstScenario = `anonymous-first-${Date.now()}`;
    const anonymousFirst = await readScenario(anonymousFirstScenario);
    const authorizedAfterAnonymous = await readScenario(anonymousFirstScenario, "Bearer user-b");
    expectAnonymousCachePolicy(anonymousFirst.headers);
    expectAuthorizedNoStore(authorizedAfterAnonymous.headers);
    expect(authorizedAfterAnonymous.payload.token).not.toBe(anonymousFirst.payload.token);
  });

  test("does not cache a middleware draft transition on an ISR MISS", async ({ request }) => {
    await setDraftMode(request, false);
    const scenario = `middleware-miss-${Date.now()}`;

    const draft = await request.get(`${BASE_URL}/api/draft-isr/${scenario}?draft=true`);
    expect(draft.status()).toBe(200);
    const draftPayload = (await draft.json()) as { draftMode: boolean; token: string };
    expect(draftPayload.draftMode).toBe(true);
    expect(draft.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(draft.headers()["cache-control"]).toContain("no-store");
    expect(draft.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
    const anonymous = await readDraftIsrRoute(request, scenario);
    expect(anonymous.payload.draftMode).toBe(false);
    expect(anonymous.payload.token).not.toBe(draftPayload.token);
  });

  test("preserves a middleware draft transition instead of serving a prewarmed HIT", async ({
    request,
  }) => {
    await setDraftMode(request, false);
    const scenario = `middleware-hit-${Date.now()}`;
    const prewarmed = await readDraftIsrRoute(request, scenario);

    const draft = await request.get(`${BASE_URL}/api/draft-isr/${scenario}?draft=true`);
    expect(draft.status()).toBe(200);
    const draftPayload = (await draft.json()) as { draftMode: boolean; token: string };
    expect(draftPayload.draftMode).toBe(true);
    expect(draftPayload.token).not.toBe(prewarmed.payload.token);
    expect(draft.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(draft.headers()["cache-control"]).toContain("no-store");
    expect(draft.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
  });

  test("does not cache a force-static route handler that enables draft mode", async ({
    request,
  }) => {
    await setDraftMode(request, false);

    const first = await request.get(`${BASE_URL}/api/draft-force-static`);
    expect(first.status()).toBe(200);
    const firstPayload = (await first.json()) as { draftMode: boolean; token: string };
    expect(firstPayload.draftMode).toBe(true);
    expect(first.headers()["set-cookie"]).toContain("__prerender_bypass=");
    expect(first.headers()["cache-control"]).toContain("no-store");
    expect(first.headers()["x-vinext-cache"]).toBeUndefined();

    await setDraftMode(request, false);
    const second = await request.get(`${BASE_URL}/api/draft-force-static`);
    const secondPayload = (await second.json()) as { draftMode: boolean; token: string };
    expect(secondPayload.draftMode).toBe(true);
    expect(secondPayload.token).not.toBe(firstPayload.token);
    expect(second.headers()["cache-control"]).toContain("no-store");

    await setDraftMode(request, false);
  });

  test("makes Link prefetches and soft navigations match the warmed RSC cache shape", async ({
    page,
  }) => {
    const aboutRscRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      const headers = request.headers();
      const isAboutPath = url.pathname === "/about" || url.pathname === "/about.rsc";
      const isRsc =
        url.pathname.endsWith(".rsc") ||
        url.searchParams.has("_rsc") ||
        headers.rsc === "1" ||
        headers.accept?.includes("text/x-component");
      if (isAboutPath && isRsc) {
        aboutRscRequests.push(request.url());
      }
    });
    const prefetchResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/about" && url.searchParams.has("_rsc");
    });
    const loadingPrefetchResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/blog/getting-started" && url.searchParams.has("_rsc");
    });
    const eligibilityManifestResponsePromise = page.waitForResponse((response) =>
      /\/vinext-rsc-prewarm-[a-f0-9]{16}\.json$/.test(new URL(response.url()).pathname),
    );
    const initialResponse = await page.goto(BASE_URL);
    expect(initialResponse).not.toBeNull();
    const initialVary = initialResponse!
      .headers()
      .vary?.split(",")
      .map((token) => token.trim());
    expect(initialVary).toContain("RSC");
    expect(initialVary).not.toContain("Accept");
    const initialHtml = await initialResponse!.text();
    expect(initialHtml).toContain('name="vinext-rsc-prewarm-manifest"');
    const eligibilityManifestMeta = initialHtml.match(
      /<meta name="vinext-rsc-prewarm-manifest" content="([^"]+)">/,
    );
    expect(eligibilityManifestMeta).not.toBeNull();

    const eligibilityManifestResponse = await eligibilityManifestResponsePromise;
    expect(eligibilityManifestResponse.status()).toBe(200);
    expect(eligibilityManifestResponse.url()).toBe(
      new URL(eligibilityManifestMeta![1], BASE_URL).href,
    );
    expect(eligibilityManifestResponse.headers()["content-type"]).toContain("application/json");
    const eligibilityManifest = (await eligibilityManifestResponse.json()) as {
      version: number;
      paths: string[];
    };
    expect(eligibilityManifest.version).toBe(1);
    expect(eligibilityManifest.paths).toContain("/about");
    expect(eligibilityManifest.paths).toContain("/blog/hello-world");
    expect(eligibilityManifest.paths).not.toContain("/force-dynamic/prefetch");
    expect(eligibilityManifest.paths).not.toContain("/force-dynamic/navigation");

    const prefetchResponse = await prefetchResponsePromise;
    const loadingPrefetchResponse = await loadingPrefetchResponsePromise;
    await prefetchResponse.finished();
    await loadingPrefetchResponse.finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    await page.click("#cdn-layout-counter");
    await expect(page.locator("#cdn-layout-counter")).toHaveText("Layout state: 1");
    await page.click("#cdn-prefetch-link");
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("#cdn-layout-counter")).toHaveText("Layout state: 1");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(aboutRscRequests).toHaveLength(1);

    const alternatePrefetchResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/about" && url.searchParams.has("_rsc");
    });
    await page.goto(`${BASE_URL}/cache-source`);
    const alternatePrefetchResponse = await alternatePrefetchResponsePromise;

    const navigationReadyPromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/about" && url.searchParams.has("_rsc");
    });
    await page.goto(BASE_URL);
    await navigationReadyPromise;
    await page.click("#cdn-layout-counter");
    await expect(page.locator("#cdn-layout-counter")).toHaveText("Layout state: 1");
    const navigationResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/blog/hello-world" && url.searchParams.has("_rsc");
    });
    await page.click("#cdn-navigation-link");
    const navigationResponse = await navigationResponsePromise;
    await expect(page.locator("h1")).toHaveText("Blog post");
    await expect(page.locator("#cdn-layout-counter")).toHaveText("Layout state: 1");

    const variantHeaders = [
      "rsc",
      "next-router-state-tree",
      "next-router-prefetch",
      "next-router-segment-prefetch",
      "next-url",
      "x-vinext-interception-context",
      "x-vinext-mounted-slots",
      "x-vinext-rsc-render-mode",
    ] as const;
    const requestShape = (response: typeof prefetchResponse) => {
      const url = new URL(response.url());
      const headers = response.request().headers();
      return {
        query: url.search,
        accept: headers.accept,
        vary: Object.fromEntries(variantHeaders.map((name) => [name, headers[name] ?? null])),
        clientReuse: headers["x-vinext-client-reuse-manifest"] ?? null,
      };
    };

    expect(requestShape(prefetchResponse)).toEqual({
      query: "?_rsc",
      accept: "text/x-component",
      vary: {
        rsc: "1",
        "next-router-state-tree": null,
        "next-router-prefetch": null,
        "next-router-segment-prefetch": null,
        "next-url": null,
        "x-vinext-interception-context": null,
        "x-vinext-mounted-slots": null,
        "x-vinext-rsc-render-mode": null,
      },
      clientReuse: null,
    });
    expect(requestShape(navigationResponse)).toEqual(requestShape(prefetchResponse));
    expect(requestShape(alternatePrefetchResponse)).toEqual(requestShape(prefetchResponse));
    expect(requestShape(loadingPrefetchResponse)).toEqual(requestShape(prefetchResponse));

    for (const response of [
      prefetchResponse,
      loadingPrefetchResponse,
      alternatePrefetchResponse,
      navigationResponse,
    ]) {
      const headers = response.headers();
      expect(headers["cache-control"]).not.toContain("no-store");
      expect(headers["cdn-cache-control"]).toContain("max-age=");
      const vary = headers.vary?.split(",").map((token) => token.trim());
      expect(vary).toContain("Accept");
      expect(vary).toContain("Cookie");
      expect(vary).toContain("Authorization");
      expect(vary).toContain("Host");
    }

    for (const accept of ["application/json", "text/x-component, */*", "TEXT/X-COMPONENT"]) {
      const nonCanonicalResponse = await page.request.get(`${BASE_URL}/about?_rsc`, {
        headers: { Accept: accept, RSC: "1" },
        maxRedirects: 0,
      });
      expect(nonCanonicalResponse.status()).toBe(307);
      expect(nonCanonicalResponse.headers()["cf-cache-status"]).not.toBe("HIT");
    }

    const cookieResponse = await page.request.get(`${BASE_URL}/about?_rsc`, {
      headers: {
        Accept: "text/x-component",
        Cookie: "__prerender_bypass=forged",
        RSC: "1",
      },
    });
    expect(cookieResponse.headers()["cache-control"]).toContain("no-store");
    expect(cookieResponse.headers()["cdn-cache-control"]).toBeUndefined();
  });

  test("waits for prewarm eligibility before an immediate no-prefetch navigation", async ({
    page,
  }) => {
    let markManifestStarted: (() => void) | undefined;
    const manifestStarted = new Promise<void>((resolve) => {
      markManifestStarted = resolve;
    });
    let releaseManifest: (() => void) | undefined;
    const manifestRelease = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    await page.route(/\/vinext-rsc-prewarm-[a-f0-9]{16}\.json$/, async (route) => {
      markManifestStarted?.();
      await manifestRelease;
      await route.continue();
    });
    let navigationStarted = false;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/blog/hello-world" && url.searchParams.has("_rsc")) {
        navigationStarted = true;
      }
    });
    const navigationRequestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === "/blog/hello-world" && url.searchParams.has("_rsc");
    });

    await page.goto(BASE_URL);
    await manifestStarted;
    const click = page.click("#cdn-navigation-link");
    await page.waitForTimeout(100);
    expect(navigationStarted).toBe(false);
    releaseManifest?.();
    const navigationRequest = await navigationRequestPromise;
    await click;
    const url = new URL(navigationRequest.url());
    const headers = navigationRequest.headers();

    expect(url.search).toBe("?_rsc");
    expect(headers.accept).toBe("text/x-component");
    expect(headers.rsc).toBe("1");
    expect(headers["next-url"]).toBeUndefined();
    expect(headers["next-router-state-tree"]).toBeUndefined();
    await expect(page.locator("h1")).toHaveText("Blog post");
  });

  test("fails a hung prewarm manifest closed to a contextual navigation", async ({ page }) => {
    let markManifestStarted: (() => void) | undefined;
    const manifestStarted = new Promise<void>((resolve) => {
      markManifestStarted = resolve;
    });
    let releaseManifest: (() => void) | undefined;
    const manifestRelease = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    await page.route(/\/vinext-rsc-prewarm-[a-f0-9]{16}\.json$/, async (route) => {
      markManifestStarted?.();
      await manifestRelease;
      await route.abort();
    });

    try {
      await page.goto(BASE_URL);
      await manifestStarted;
      const navigationRequestPromise = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === "/blog/hello-world" && url.searchParams.has("_rsc");
      });
      const click = page.click("#cdn-navigation-link");
      const navigationRequest = await navigationRequestPromise;
      const url = new URL(navigationRequest.url());
      const headers = navigationRequest.headers();

      expect(url.searchParams.get("_rsc")).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(headers.accept).toBe("text/x-component");
      expect(headers.rsc).toBe("1");
      expect(headers["next-url"]).toBe("/");
      expect(headers["next-router-state-tree"]).toBeTruthy();
      expect(headers["x-vinext-client-reuse-manifest"]).toBeTruthy();
      await click;
      await expect(page.locator("h1")).toHaveText("Blog post");
    } finally {
      releaseManifest?.();
    }
  });

  test("handles staged-version probes through the generated Worker entry", async ({ request }) => {
    const firstResponse = await request.get(`${BASE_URL}/?__vinext_version_probe=expected`, {
      headers: { "X-Vinext-Version-Probe": "1" },
    });

    expect(firstResponse.status()).toBe(204);
    expect(firstResponse.headers()["cache-control"]).toBe("no-store");
    expect(firstResponse.headers()["cdn-cache-control"]).toBeUndefined();
    const version = firstResponse.headers()["x-vinext-worker-version"];
    expect(version).toBeTruthy();
    expect(version).not.toBe("unavailable");

    // Hybrid Pages rendering runs in the separate SSR module graph. Its
    // generated registrar must observe the RSC graph's global registration
    // instead of replacing the env-bound adapter with an env-less instance.
    const pagesResponse = await request.get(`${BASE_URL}/pages-about`);
    expect(pagesResponse.status()).toBe(200);

    const secondResponse = await request.get(`${BASE_URL}/?__vinext_version_probe=expected`, {
      headers: { "X-Vinext-Version-Probe": "1" },
    });
    expect(secondResponse.status()).toBe(204);
    expect(secondResponse.headers()["x-vinext-worker-version"]).toBe(version);
  });

  test("keeps source-specific headers and hashed URLs for force-dynamic RSC requests", async ({
    page,
  }) => {
    const prefetchResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/force-dynamic/prefetch" && url.searchParams.has("_rsc");
    });
    await page.goto(`${BASE_URL}/force-dynamic-source`);
    const prefetchResponse = await prefetchResponsePromise;
    await prefetchResponse.finished();

    await page.click("#cdn-layout-counter");
    await expect(page.locator("#cdn-layout-counter")).toHaveText("Layout state: 1");
    const navigationResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/force-dynamic/navigation" && url.searchParams.has("_rsc");
    });
    await page.click("#cdn-dynamic-navigation-link");
    const navigationResponse = await navigationResponsePromise;
    await expect(page.locator("h1")).toHaveText("Force dynamic navigation");
    await expect(page.locator("#cdn-layout-counter")).toHaveText("Layout state: 1");

    const requestShape = (response: typeof prefetchResponse) => {
      const url = new URL(response.url());
      const headers = response.request().headers();
      return {
        url,
        headers,
        rscHash: url.searchParams.get("_rsc"),
      };
    };
    const prefetch = requestShape(prefetchResponse);
    const navigation = requestShape(navigationResponse);

    for (const request of [prefetch, navigation]) {
      expect(request.rscHash).toMatch(/^[A-Za-z0-9_-]{16}$/);
      await expect(computeRscCacheBustingSearchParam(new Headers(request.headers))).resolves.toBe(
        request.rscHash,
      );
      expect(request.url.search).toBe(`?_rsc=${request.rscHash}`);
      expect(request.headers.accept).toBe("text/x-component");
      expect(request.headers.rsc).toBe("1");
      expect(request.headers["next-router-state-tree"]).toBeTruthy();
      expect(request.headers["next-url"]).toBe("/force-dynamic-source");
    }
    expect(navigation.rscHash).not.toBe(prefetch.rscHash);

    expect(prefetch.headers["next-router-prefetch"]).toBe("1");
    expect(prefetch.headers["next-router-segment-prefetch"]).toBe("1");
    expect(navigation.headers["next-router-prefetch"]).toBeUndefined();
    expect(navigation.headers["next-router-segment-prefetch"]).toBeUndefined();
    expect(navigation.headers["x-vinext-client-reuse-manifest"]).toBeTruthy();

    for (const response of [prefetchResponse, navigationResponse]) {
      const headers = response.headers();
      expect(headers["cache-control"]).toContain("no-store");
      expect(headers["cdn-cache-control"]).toBeUndefined();
      expect(headers["cloudflare-cdn-cache-control"]).toBeUndefined();
      expect(headers["cache-tag"]).toBeUndefined();
    }
  });

  // Next.js keeps Next-Url in the client route-cache identity when the RSC
  // response varies by source route. See vercel/next.js#88863.
  test("does not reuse force-dynamic RSC payloads across source routes", async ({ page }) => {
    const sourceAPrefetchPromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/force-dynamic/prefetch" && url.searchParams.has("_rsc");
    });
    await page.goto(`${BASE_URL}/force-dynamic-source`);
    const sourceAPrefetch = await sourceAPrefetchPromise;
    expect(sourceAPrefetch.request().headers()["next-url"]).toBe("/force-dynamic-source");
    expect(sourceAPrefetch.headers().vary?.toLowerCase().split(/,\s*/)).toContain("next-url");

    await page.click("#cdn-dynamic-prefetch-link");
    await expect(
      page.getByRole("heading", { name: "Force dynamic prefetch", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#cdn-dynamic-next-url")).toHaveText(
      "Next URL: /force-dynamic-source",
    );

    const sourceBPrefetchPromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/force-dynamic/prefetch" && url.searchParams.has("_rsc");
    });
    await page.click("#cdn-dynamic-source-b-link");
    await expect(page).toHaveURL(`${BASE_URL}/force-dynamic-source-b`);
    const sourceBPrefetch = await sourceBPrefetchPromise;
    expect(sourceBPrefetch.request().headers()["next-url"]).toBe("/force-dynamic-source-b");
    expect(sourceBPrefetch.headers().vary?.toLowerCase().split(/,\s*/)).toContain("next-url");
    expect(new URL(sourceBPrefetch.url()).searchParams.get("_rsc")).not.toBe(
      new URL(sourceAPrefetch.url()).searchParams.get("_rsc"),
    );

    await page.click("#cdn-dynamic-prefetch-link");
    await expect(
      page.getByRole("heading", { name: "Force dynamic prefetch", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#cdn-dynamic-next-url")).toHaveText(
      "Next URL: /force-dynamic-source-b",
    );
  });
});
