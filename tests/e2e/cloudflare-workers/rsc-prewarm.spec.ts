import {
  expect,
  test,
  type APIRequest,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Response,
} from "@playwright/test";
import fs from "node:fs";
import { VINEXT_EXPECTED_WORKER_VERSION_HEADER } from "../../../packages/cloudflare/src/version-headers.js";

const TARGET_PATH = "/prewarm-target";
const PAGES_TARGET_PATH = "/pages-prewarm";
const CACHEABILITY_PROBE_HEADER = "X-Vinext-Cacheability-Probe";
const PRERENDER_SECRET_HEADER = "X-Vinext-Prerender-Secret";
const LOADING_SHELL_RSC_SEARCH = "?_rsc=9qLBDIU2NgN178cB";
const PROMOTION_STABILITY_WINDOW_MS = 60_000;
const PROMOTION_READINESS_TIMEOUT_MS = 120_000;
const PROMOTION_PROBE_INTERVAL_MS = 1_000;
const STALE_SEED_RETRY_TIMEOUT_MS = 45_000;

type ObservedRsc = {
  headers: Record<string, string>;
  response: Response;
  url: URL;
};

test.describe.configure({ retries: 0 });

class StaleSeedWorkerError extends Error {}

function rejectStaleSeedWorker(response: Response | null): void {
  if (response?.headers()["x-vinext-seed-worker"] === "1") {
    throw new StaleSeedWorkerError("request reached the stale seed Worker after promotion");
  }
}

async function getResponseAfterPromotion(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  const deadline = Date.now() + STALE_SEED_RETRY_TIMEOUT_MS;
  let lastSeedStatus: number | undefined;

  do {
    const response = await request.get(url, { headers });
    if (response.headers()["x-vinext-seed-worker"] !== "1") {
      return response;
    }
    lastSeedStatus = response.status();
    await response.dispose();
    await new Promise((resolve) => setTimeout(resolve, PROMOTION_PROBE_INTERVAL_MS));
  } while (Date.now() < deadline);

  throw new Error(
    `stale seed Worker remained reachable for prewarmed request: ${lastSeedStatus ?? "unknown status"}`,
  );
}

async function observeRsc(page: Page, action: () => Promise<unknown>): Promise<ObservedRsc> {
  const responsePromise = page.waitForResponse(
    (response) => {
      const request = response.request();
      return new URL(response.url()).pathname === TARGET_PATH && request.headers().rsc === "1";
    },
    { timeout: 15_000 },
  );
  try {
    await action();
  } catch (error) {
    void responsePromise.catch(() => {});
    throw error;
  }
  const response = await responsePromise;
  return {
    headers: response.request().headers(),
    response,
    url: new URL(response.url()),
  };
}

function expectCanonical(observed: ObservedRsc, rscBuildId: string): void {
  rejectStaleSeedWorker(observed.response);
  console.log(
    `RSC cache trace: url=${observed.url.pathname}${observed.url.search} ` +
      `cache=${observed.response.headers()["cf-cache-status"] ?? "missing"} ` +
      `ray=${observed.response.headers()["cf-ray"] ?? "missing"} ` +
      `encoding=${observed.response.headers()["content-encoding"] ?? "identity"}`,
  );
  expect(observed.url.pathname).toBe(TARGET_PATH);
  expect(observed.headers.accept).toBe("text/x-component");
  expect(observed.headers.rsc).toBe("1");
  expect(observed.headers["next-router-state-tree"]).toBeUndefined();
  expect(observed.headers["next-url"]).toBeUndefined();
  expect(observed.headers["x-vinext-rsc-state-fingerprint"]).toBeUndefined();
  expect(observed.response.headers()["x-vinext-rsc-build-id"]).toBe(rscBuildId);
  expect(
    observed.response.headers()["cf-cache-status"],
    JSON.stringify({ request: observed.headers, response: observed.response.headers() }),
  ).toBe("HIT");
}

function expectFull(observed: ObservedRsc, rscBuildId: string): void {
  expectCanonical(observed, rscBuildId);
  expect(observed.url.search).toBe("?_rsc");
  expect(observed.headers["next-router-prefetch"]).toBeUndefined();
  expect(observed.headers["next-router-segment-prefetch"]).toBeUndefined();
  expect(observed.headers["x-vinext-rsc-render-mode"]).toBeUndefined();
}

function expectLoadingShell(observed: ObservedRsc, rscBuildId: string): void {
  expectCanonical(observed, rscBuildId);
  expect(observed.url.search).toBe(LOADING_SHELL_RSC_SEARCH);
  expect(observed.headers["next-router-prefetch"]).toBe("1");
  expect(observed.headers["next-router-segment-prefetch"]).toBe("1");
  expect(observed.headers["x-vinext-rsc-render-mode"]).toBe("prefetch-loading-shell");
}

async function waitForStablePromotion({
  baseURL,
  buildId,
  playwright,
  rscBuildId,
}: {
  baseURL: string;
  buildId: string;
  playwright: { request: APIRequest };
  rscBuildId: string;
}): Promise<void> {
  const deadline = Date.now() + PROMOTION_READINESS_TIMEOUT_MS;
  let attempt = 0;
  let lastFailure: unknown;
  let stableSince: number | undefined;

  while (Date.now() < deadline) {
    const probeId = `${Date.now()}-${attempt++}`;
    const probeRequest = await playwright.request.newContext();
    try {
      const versionUrl = new URL("/api/prewarm-version", baseURL);
      versionUrl.searchParams.set("readiness", probeId);
      const versionResponse = await probeRequest.get(versionUrl.href, { timeout: 5_000 });
      expect(versionResponse.ok()).toBe(true);
      expect(versionResponse.headers()["cache-control"]).toContain("no-store");
      expect(await versionResponse.json()).toEqual({ buildId, rscBuildId });

      stableSince ??= Date.now();
      if (Date.now() - stableSince >= PROMOTION_STABILITY_WINDOW_MS) {
        return;
      }
    } catch (error) {
      lastFailure = error;
      stableSince = undefined;
    } finally {
      await probeRequest.dispose();
    }

    await new Promise((resolve) => setTimeout(resolve, PROMOTION_PROBE_INTERVAL_MS));
  }

  throw new Error(
    `Worker promotion did not remain stable for ${PROMOTION_STABILITY_WINDOW_MS}ms: ${String(lastFailure)}`,
  );
}

test("deploy-prewarmed Pages HTML and RSC variants are reused", async ({
  baseURL,
  browser,
  playwright,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(240_000);

  const buildId = fs.readFileSync("examples/workers-cache/dist/server/BUILD_ID", "utf-8").trim();
  const rscBuildId = fs
    .readFileSync("examples/workers-cache/dist/server/RSC_BUILD_ID", "utf-8")
    .trim();
  const prerenderSecret = (
    JSON.parse(
      fs.readFileSync("examples/workers-cache/dist/server/vinext-server.json", "utf-8"),
    ) as { prerenderSecret: string }
  ).prerenderSecret;

  const fullHeaders = { accept: "text/x-component", rsc: "1" };
  const shellHeaders = {
    ...fullHeaders,
    "next-router-prefetch": "1",
    "next-router-segment-prefetch": "1",
    "x-vinext-rsc-render-mode": "prefetch-loading-shell",
  };

  // Worker promotion is not globally atomic: one request can reach the new
  // version while a subsequent request still reaches the old one. Require a
  // sustained readiness window using fresh clients and unique requests to the
  // no-store version endpoint. This proves the promoted build is stable
  // without touching either canonical cache entry before its HIT assertion.
  await waitForStablePromotion({ baseURL, buildId, playwright, rscBuildId });

  // Exercise authenticated warm mode inside workerd on a fresh, unmanifested
  // concrete path. This is the same runtime path the final deploy uses after
  // promotion, including late body classification and CDN header admission.
  const warmSlug = `e2e-warm-${Date.now()}`;
  const warmPath = `/cache-probe/bare-fetch/${warmSlug}`;
  const warmResponse = await request.get(`${baseURL}${warmPath}`, {
    headers: {
      [CACHEABILITY_PROBE_HEADER]: "warm",
      [PRERENDER_SECRET_HEADER]: prerenderSecret,
    },
  });
  expect(warmResponse.ok()).toBe(true);
  expect(warmResponse.headers()["cf-cache-status"]).toBe("MISS");
  expect(await warmResponse.text()).toContain(`cache-probe bare fetch ${warmSlug}`);
  const warmedResponse = await request.get(`${baseURL}${warmPath}`);
  expect(warmedResponse.headers()["cf-cache-status"]).toBe("HIT");
  await warmedResponse.dispose();

  // The embedded manifest is route classification, not a warmed artifact.
  // Purging the CDN entry must therefore allow the same final Worker to admit
  // and refill it again without another probe deployment.
  const purgeTarget = "/cache-probe/static/known";
  const beforePurge = await getResponseAfterPromotion(request, `${baseURL}${purgeTarget}`);
  expect(beforePurge.headers()["cf-cache-status"]).toBe("HIT");
  await beforePurge.dispose();
  const purge = await request.post(`${baseURL}/api/revalidate-path`, {
    data: { path: purgeTarget },
  });
  expect(purge.ok()).toBe(true);
  await purge.dispose();
  const refilled = await getResponseAfterPromotion(request, `${baseURL}${purgeTarget}`);
  expect(refilled.headers()["cf-cache-status"]).toBe("MISS");
  await refilled.dispose();
  const reusedAfterPurge = await getResponseAfterPromotion(request, `${baseURL}${purgeTarget}`);
  expect(reusedAfterPurge.headers()["cf-cache-status"]).toBe("HIT");
  await reusedAfterPurge.dispose();

  const workerName = new URL(baseURL).hostname.split(".")[0];
  const downstreamOnlyOverride = await request.get(`${baseURL}/api/prewarm-version?downstream=1`, {
    headers: {
      "Cloudflare-Workers-Version-Overrides":
        'unrelated-downstream="00000000-0000-4000-8000-000000000000"',
    },
  });
  expect(downstreamOnlyOverride.ok()).toBe(true);

  const mismatchedOverride = await request.get(`${baseURL}/api/prewarm-version?mismatch=1`, {
    headers: {
      "Cloudflare-Workers-Version-Overrides": `${workerName}="00000000-0000-4000-8000-000000000000"`,
      [VINEXT_EXPECTED_WORKER_VERSION_HEADER]: "00000000-0000-4000-8000-000000000000",
    },
  });
  expect(mismatchedOverride.status()).toBe(503);
  expect(mismatchedOverride.headers()["cache-control"]).toBe("no-store");
  expect(await mismatchedOverride.text()).toContain("Cloudflare invoked Worker version");

  const pagesResponse = await getResponseAfterPromotion(request, `${baseURL}${PAGES_TARGET_PATH}`);
  const pagesResponseHeaders = pagesResponse.headers();
  expect(pagesResponse.ok(), JSON.stringify(pagesResponseHeaders)).toBe(true);
  expect(pagesResponseHeaders["content-type"]).toContain("text/html");
  expect(pagesResponseHeaders["x-vinext-build-id"]).toBe(rscBuildId);
  expect(
    pagesResponseHeaders["cf-cache-status"],
    `Pages response headers: ${JSON.stringify(pagesResponseHeaders)}`,
  ).toBe("HIT");
  expect(await pagesResponse.text()).toContain("Pages prewarm target");

  const appHtmlResponse = await getResponseAfterPromotion(request, `${baseURL}${TARGET_PATH}`);
  const appHtmlResponseHeaders = appHtmlResponse.headers();
  expect(appHtmlResponse.ok(), JSON.stringify(appHtmlResponseHeaders)).toBe(true);
  expect(appHtmlResponseHeaders["content-type"]).toContain("text/html");
  expect(appHtmlResponseHeaders["x-vinext-build-id"]).toBe(rscBuildId);
  expect(
    appHtmlResponseHeaders["cf-cache-status"],
    `App HTML response headers: ${JSON.stringify(appHtmlResponseHeaders)}`,
  ).toBe("HIT");
  expect(await appHtmlResponse.text()).toContain("Prewarm target");

  // Ported from Next.js:
  // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
  // An unconditional config policy remains authoritative even when the App
  // page deliberately renders dynamically.
  const explicitPolicyResponse = await getResponseAfterPromotion(
    request,
    `${baseURL}/cache-probe/config-cache`,
  );
  const explicitPolicyHeaders = explicitPolicyResponse.headers();
  expect(explicitPolicyResponse.ok(), JSON.stringify(explicitPolicyHeaders)).toBe(true);
  expect(explicitPolicyHeaders["cf-cache-status"]).toBe("HIT");
  expect(await explicitPolicyResponse.text()).toContain(
    "Force-dynamic page with an explicit config cache policy",
  );

  for (const [pathname, marker] of [
    ["/cache-probe/config-pages-ssr", "Pages SSR with an explicit config cache policy"],
    ["/cache-probe/user-pages-ssr", "Pages SSR with a response cache policy"],
    ["/cache-probe/config-route", "Route Handler with an explicit config cache policy"],
    ["/cache-probe/route-user-cache", "Dynamic Route Handler with a response cache policy"],
  ] as const) {
    const response = await getResponseAfterPromotion(request, `${baseURL}${pathname}`);
    const headers = response.headers();
    expect(response.ok(), `${pathname}: ${JSON.stringify(headers)}`).toBe(true);
    expect(headers["cf-cache-status"], `${pathname}: ${JSON.stringify(headers)}`).toBe("HIT");
    expect(await response.text()).toContain(marker);
  }

  const fullResponse = await getResponseAfterPromotion(
    request,
    `${baseURL}${TARGET_PATH}?_rsc`,
    fullHeaders,
  );
  const fullResponseHeaders = fullResponse.headers();
  expect(fullResponse.ok(), JSON.stringify(fullResponseHeaders)).toBe(true);
  expect(fullResponseHeaders["content-type"]).toContain("text/x-component");
  expect(fullResponseHeaders["x-vinext-rsc-build-id"]).toBe(rscBuildId);
  expect(
    fullResponseHeaders["cf-cache-status"],
    `full RSC response headers: ${JSON.stringify(fullResponseHeaders)}`,
  ).toBe("HIT");
  const fullBody = await fullResponse.text();
  expect(fullBody).toContain(buildId);
  expect(fullBody).toContain("Prewarm target");

  const shellResponse = await getResponseAfterPromotion(
    request,
    `${baseURL}${TARGET_PATH}${LOADING_SHELL_RSC_SEARCH}`,
    shellHeaders,
  );
  const shellResponseHeaders = shellResponse.headers();
  expect(shellResponse.ok()).toBe(true);
  expect(shellResponseHeaders["content-type"]).toContain("text/x-component");
  expect(shellResponseHeaders["x-vinext-rsc-build-id"]).toBe(rscBuildId);
  expect(
    shellResponseHeaders["cf-cache-status"],
    `loading-shell RSC response headers: ${JSON.stringify(shellResponseHeaders)}`,
  ).toBe("HIT");
  const shellBody = await shellResponse.text();
  expect(shellBody).toContain(buildId);
  expect(shellBody).toContain("prewarm-loading-shell");
  expect(shellBody).not.toContain("Prewarm target");
  expect(shellBody).not.toBe(fullBody);

  const staleSeedDeadline = Date.now() + STALE_SEED_RETRY_TIMEOUT_MS;
  const runFresh = async (run: (page: Page) => Promise<void>) => {
    let staleSeedFailure: StaleSeedWorkerError | undefined;
    do {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await run(page);
        return;
      } catch (error) {
        if (!(error instanceof StaleSeedWorkerError)) throw error;
        staleSeedFailure = error;
      } finally {
        await context.close();
      }
      await new Promise((resolve) => setTimeout(resolve, PROMOTION_PROBE_INTERVAL_MS));
    } while (Date.now() < staleSeedDeadline);

    throw new Error(
      `stale seed Worker remained reachable after promotion: ${String(staleSeedFailure)}`,
    );
  };

  const gotoCurrentBuild = async (page: Page, pathname: string) => {
    const response = await page.goto(pathname);
    rejectStaleSeedWorker(response);
    expect(response?.ok()).toBe(true);
    await expect(page.getByTestId("build-id")).toHaveText(buildId);
  };
  const expectTargetCommit = async (page: Page) => {
    await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
    await expect(page.getByRole("heading", { name: "Prewarm target" })).toBeVisible();
    await expect(page.getByTestId("build-id")).toHaveText(buildId);
  };

  for (const source of ["/prewarm/link-a", "/prewarm/link-b"]) {
    await runFresh(async (page) => {
      const shell = await observeRsc(page, async () => {
        await gotoCurrentBuild(page, source);
      });
      expectLoadingShell(shell, rscBuildId);

      const full = await observeRsc(page, () => page.getByTestId("link-prefetch").click());
      expectFull(full, rscBuildId);
      await expectTargetCommit(page);
    });
  }

  await runFresh(async (page) => {
    await gotoCurrentBuild(page, "/prewarm/router");
    const shell = await observeRsc(page, () => page.getByTestId("router-prefetch").click());
    expectLoadingShell(shell, rscBuildId);

    const full = await observeRsc(page, () => page.getByTestId("router-navigate").click());
    expectFull(full, rscBuildId);
    await expectTargetCommit(page);
  });

  await runFresh(async (page) => {
    let targetRscRequests = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === TARGET_PATH && request.headers().rsc === "1") {
        targetRscRequests++;
      }
    });
    const full = await observeRsc(page, async () => {
      await gotoCurrentBuild(page, "/prewarm/full");
    });
    expectFull(full, rscBuildId);
    expect(targetRscRequests).toBe(1);
    await page.getByTestId("link-prefetch").click();
    await expectTargetCommit(page);
    expect(targetRscRequests).toBe(1);
  });

  await runFresh(async (page) => {
    await gotoCurrentBuild(page, "/prewarm/soft");
    const full = await observeRsc(page, () => page.getByTestId("soft-navigation").click());
    expectFull(full, rscBuildId);
    await expectTargetCommit(page);
  });

  await runFresh(async (page) => {
    const dynamicResponsePromise = page.waitForResponse((response) => {
      const request = response.request();
      return new URL(response.url()).pathname === "/dynamic" && request.headers().rsc === "1";
    });
    await gotoCurrentBuild(page, "/prewarm/dynamic");
    const dynamic = await dynamicResponsePromise;
    rejectStaleSeedWorker(dynamic);
    expect(dynamic.ok()).toBe(true);
    expect(dynamic.headers()["cache-control"]).toContain("no-store");
    expect(dynamic.headers()["cf-cache-status"]).toBe("BYPASS");
  });

  // Cacheability expectations mirror Next.js's completed-render classification:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic-data/dynamic-data.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts
  const staticParamsResponse = await getResponseAfterPromotion(
    request,
    `${baseURL}/cache-probe/static/known`,
  );
  expect(staticParamsResponse.ok()).toBe(true);
  expect(staticParamsResponse.headers()["cf-cache-status"]).toBe("HIT");
  expect((await staticParamsResponse.text()).replaceAll("<!-- -->", "")).toContain(
    "cache-probe static params known",
  );

  const bareFetchResponse = await getResponseAfterPromotion(
    request,
    `${baseURL}/cache-probe/bare-fetch/known`,
  );
  expect(bareFetchResponse.ok()).toBe(true);
  expect(bareFetchResponse.headers()["cf-cache-status"]).toBe("HIT");
  expect((await bareFetchResponse.text()).replaceAll("<!-- -->", "")).toContain(
    "cache-probe bare fetch known",
  );
  const bareFetchRscResponse = await getResponseAfterPromotion(
    request,
    `${baseURL}/cache-probe/bare-fetch/known?_rsc`,
    fullHeaders,
  );
  expect(bareFetchRscResponse.headers()["cf-cache-status"]).toBe("HIT");
  expect(bareFetchRscResponse.headers()["content-type"]).toContain("text/x-component");

  const onDemandBareFetchSlug = `on-demand-bare-${buildId.slice(0, 8)}`;
  const onDemandBareFetchUrl = `${baseURL}/cache-probe/bare-fetch/${onDemandBareFetchSlug}`;
  const onDemandBareFetchMiss = await getResponseAfterPromotion(request, onDemandBareFetchUrl);
  expect(onDemandBareFetchMiss.headers()["cf-cache-status"]).toBe("MISS");
  expect((await onDemandBareFetchMiss.text()).replaceAll("<!-- -->", "")).toContain(
    `cache-probe bare fetch ${onDemandBareFetchSlug}`,
  );
  const onDemandBareFetchHit = await getResponseAfterPromotion(request, onDemandBareFetchUrl);
  expect(onDemandBareFetchHit.headers()["cf-cache-status"]).toBe("HIT");

  // Only `known` was discovered and warmed. Like Next.js fallback blocking,
  // another parameter is checked from its completed first render and then
  // admitted without requiring a second deploy or a manifest entry per path.
  const onDemandSlug = `on-demand-${buildId.slice(0, 8)}`;
  const onDemandUrl = `${baseURL}/cache-probe/static/${onDemandSlug}`;
  const onDemandMiss = await getResponseAfterPromotion(request, onDemandUrl);
  expect(onDemandMiss.headers()["cf-cache-status"]).toBe("MISS");
  expect((await onDemandMiss.text()).replaceAll("<!-- -->", "")).toContain(
    `cache-probe static params ${onDemandSlug}`,
  );
  const onDemandHit = await getResponseAfterPromotion(request, onDemandUrl);
  expect(onDemandHit.headers()["cf-cache-status"]).toBe("HIT");

  const staticRouteResponse = await getResponseAfterPromotion(
    request,
    `${baseURL}/cache-probe/route-static`,
  );
  expect(staticRouteResponse.headers()["cf-cache-status"]).toBe("HIT");
  expect(await staticRouteResponse.text()).toBe("cache-probe static route handler");

  const generatedStaticRouteResponse = await getResponseAfterPromotion(
    request,
    `${baseURL}/cache-probe/route-static/known`,
  );
  // This route revalidates after 60 seconds, the same duration as the
  // promotion-stability window. UPDATING is a cached stale response while the
  // edge refreshes it in the background; only MISS/BYPASS would be a failure.
  expect(["HIT", "UPDATING"]).toContain(generatedStaticRouteResponse.headers()["cf-cache-status"]);
  expect(await generatedStaticRouteResponse.text()).toBe("cache-probe static route handler known");

  const expectDynamic = async (
    pathname: string,
    expectedBody: string,
    headers?: Record<string, string>,
  ): Promise<void> => {
    const response = await getResponseAfterPromotion(request, `${baseURL}${pathname}`, headers);
    const responseHeaders = response.headers();
    expect(response.ok(), JSON.stringify(responseHeaders)).toBe(true);
    expect(responseHeaders["cache-control"]).toContain("no-store");
    expect(responseHeaders["cf-cache-status"]).toBe("BYPASS");
    expect((await response.text()).replaceAll("<!-- -->", "")).toContain(expectedBody);
  };

  await expectDynamic("/cache-probe/cookies", "cache-probe cookie first", {
    cookie: "cache-probe=first",
  });
  await expectDynamic("/cache-probe/cookies", "cache-probe cookie second", {
    cookie: "cache-probe=second",
  });
  await expectDynamic("/cache-probe/headers", "cache-probe header first", {
    "x-cache-probe": "first",
  });
  await expectDynamic("/cache-probe/headers", "cache-probe header second", {
    "x-cache-probe": "second",
  });
  await expectDynamic("/cache-probe/search?value=first", "cache-probe search first");
  await expectDynamic("/cache-probe/search?value=second", "cache-probe search second");
  await expectDynamic("/cache-probe/no-store", "cache-probe no-store fetch");
  await expectDynamic("/cache-probe/route-request?value=first", '"value":"first"');
  await expectDynamic("/cache-probe/route-request?value=second", '"value":"second"');
});
