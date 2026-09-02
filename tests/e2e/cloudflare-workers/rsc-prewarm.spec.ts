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
import { randomUUID } from "node:crypto";
import { VINEXT_EXPECTED_WORKER_VERSION_HEADER } from "../../../packages/cloudflare/src/version-headers.js";

const TARGET_PATH = "/prewarm-target";
const PAGES_TARGET_PATH = "/pages-prewarm";
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

async function getReusableResponseAfterPromotion(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
  label: string,
): Promise<APIResponse> {
  const response = await getResponseAfterPromotion(request, url, headers);
  const responseHeaders = response.headers();
  if (responseHeaders["cf-cache-status"] !== "MISS") return response;

  // Workers Cache is tiered. A deploy fill and this verification request can
  // traverse different lower/upper tiers, so the first request from this
  // client may still be a MISS. MISS means Cloudflare admitted the completed
  // response; require the same client to reuse that exact entry immediately.
  const trace = `${label} first response headers: ${JSON.stringify(responseHeaders)}`;
  expect(responseHeaders["cdn-cache-control"], trace).toContain("public");
  expect(responseHeaders["cache-control"], trace).not.toContain("no-store");
  await response.body();

  const reused = await getResponseAfterPromotion(request, url, headers);
  expect(
    reused.headers()["cf-cache-status"],
    `${label} reused response headers: ${JSON.stringify(reused.headers())}`,
  ).toBe("HIT");
  return reused;
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
  const responseHeaders = observed.response.headers();
  console.log(
    `RSC cache trace: url=${observed.url.pathname}${observed.url.search} ` +
      `cache=${responseHeaders["cf-cache-status"] ?? "missing"} ` +
      `ray=${responseHeaders["cf-ray"] ?? "missing"} ` +
      `encoding=${responseHeaders["content-encoding"] ?? "identity"}`,
  );
  expect(observed.url.pathname).toBe(TARGET_PATH);
  expect(observed.headers.accept).toBe("text/x-component");
  expect(observed.headers.rsc).toBe("1");
  expect(observed.headers["next-router-state-tree"]).toBeUndefined();
  expect(observed.headers["next-url"]).toBeUndefined();
  expect(observed.headers["x-vinext-rsc-state-fingerprint"]).toBeUndefined();
  expect(responseHeaders["x-vinext-rsc-build-id"]).toBe(rscBuildId);

  const trace = JSON.stringify({ request: observed.headers, response: responseHeaders });
  const cacheStatus = responseHeaders["cf-cache-status"];
  expect(["HIT", "MISS"], trace).toContain(cacheStatus);
  if (cacheStatus === "MISS") {
    // Chromium negotiates zstd while the Node-based deploy warmer negotiates
    // br. A browser may therefore fill a separate encoded edge object even
    // though the canonical representation was already warmed and verified.
    expect(responseHeaders["cdn-cache-control"], trace).toContain("public");
    expect(responseHeaders["cache-control"], trace).not.toContain("no-store");
  }
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

test("deploy-prewarmed variants are reused and late-dynamic HTML stays private", async ({
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
  const { prerenderSecret } = JSON.parse(
    fs.readFileSync("examples/workers-cache/dist/server/vinext-server.json", "utf-8"),
  ) as { prerenderSecret: string };

  // Match a browser navigation and the HTML request emitted by cdn-warm.ts.
  // Playwright's APIRequestContext otherwise sends `Accept: */*`, which is a
  // different representation from the one this deployed regression warms.
  const htmlHeaders = { accept: "text/html" };
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

  // A browser fetch() uses Accept: */* by default. The resolved App Page kind,
  // rather than that header, must authorize a fresh HTML cache identity. This
  // query is unique so the first response necessarily exercises Worker
  // admission instead of the canonical entry populated during deployment.
  const browserFetchUrl = new URL("/cached/intro", baseURL);
  browserFetchUrl.searchParams.set("browser-fetch", randomUUID());
  const browserFetchMiss = await request.get(browserFetchUrl.href, {
    headers: { accept: "*/*" },
  });
  const browserFetchMissHeaders = browserFetchMiss.headers();
  expect(browserFetchMiss.ok(), JSON.stringify(browserFetchMissHeaders)).toBe(true);
  expect(browserFetchMissHeaders["content-type"]).toContain("text/html");
  expect(browserFetchMissHeaders["cf-cache-status"]).toBe("MISS");
  expect(browserFetchMissHeaders["cdn-cache-control"]).toContain("public");
  expect(browserFetchMissHeaders["cache-control"]).not.toContain("no-store");
  const browserFetchBody = await browserFetchMiss.text();

  const browserFetchHit = await request.get(browserFetchUrl.href, {
    headers: { accept: "*/*" },
  });
  expect(browserFetchHit.headers()["cf-cache-status"]).toBe("HIT");
  expect(await browserFetchHit.text()).toBe(browserFetchBody);

  const downstreamOnlyOverride = await request.get(`${baseURL}/api/prewarm-version?downstream=1`, {
    headers: {
      "Cloudflare-Workers-Version-Overrides":
        'unrelated-downstream="00000000-0000-4000-8000-000000000000"',
    },
  });
  expect(downstreamOnlyOverride.ok()).toBe(true);

  const mismatchedOverride = await request.get(`${baseURL}/api/prewarm-version?mismatch=1`, {
    headers: {
      // The deploy path already exercises a real same-Worker version
      // override. Keep this request on the current version so vinext can
      // deterministically reject the deliberately mismatched assertion;
      // asking Cloudflare to dispatch this Worker to a fabricated version can
      // fail at the platform routing layer before vinext runs.
      "Cloudflare-Workers-Version-Overrides":
        'unrelated-downstream="00000000-0000-4000-8000-000000000000"',
      [VINEXT_EXPECTED_WORKER_VERSION_HEADER]: "00000000-0000-4000-8000-000000000000",
    },
  });
  const mismatchedOverrideHeaders = mismatchedOverride.headers();
  const mismatchedOverrideBody = await mismatchedOverride.text();
  const mismatchedOverrideTrace = JSON.stringify({
    body: mismatchedOverrideBody,
    headers: mismatchedOverrideHeaders,
    status: mismatchedOverride.status(),
  });
  expect(mismatchedOverride.status(), mismatchedOverrideTrace).toBe(503);
  expect(mismatchedOverrideHeaders["cache-control"], mismatchedOverrideTrace).toBe("no-store");
  expect(mismatchedOverrideBody, mismatchedOverrideTrace).toContain(
    "Cloudflare invoked Worker version",
  );

  const pagesResponse = await getReusableResponseAfterPromotion(
    request,
    `${baseURL}${PAGES_TARGET_PATH}`,
    htmlHeaders,
    "Pages HTML",
  );
  const pagesResponseHeaders = pagesResponse.headers();
  expect(pagesResponse.ok(), JSON.stringify(pagesResponseHeaders)).toBe(true);
  expect(pagesResponseHeaders["content-type"]).toContain("text/html");
  expect(pagesResponseHeaders["x-vinext-build-id"]).toBe(rscBuildId);
  expect(pagesResponseHeaders["cache-control"]).toContain("public");
  expect(
    pagesResponseHeaders["cf-cache-status"],
    `Pages response headers: ${JSON.stringify(pagesResponseHeaders)}`,
  ).toBe("HIT");
  expect(await pagesResponse.text()).toContain("Pages prewarm target");

  const appHtmlResponse = await getReusableResponseAfterPromotion(
    request,
    `${baseURL}${TARGET_PATH}`,
    htmlHeaders,
    "App HTML",
  );
  const appHtmlResponseHeaders = appHtmlResponse.headers();
  expect(appHtmlResponse.ok(), JSON.stringify(appHtmlResponseHeaders)).toBe(true);
  expect(appHtmlResponseHeaders["content-type"]).toContain("text/html");
  expect(appHtmlResponseHeaders["x-vinext-build-id"]).toBe(rscBuildId);
  expect(
    appHtmlResponseHeaders["cf-cache-status"],
    `App HTML response headers: ${JSON.stringify(appHtmlResponseHeaders)}`,
  ).toBe("HIT");
  expect(await appHtmlResponse.text()).toContain("Prewarm target");

  const fullResponse = await getReusableResponseAfterPromotion(
    request,
    `${baseURL}${TARGET_PATH}?_rsc`,
    fullHeaders,
    "full RSC",
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

  const shellResponse = await getReusableResponseAfterPromotion(
    request,
    `${baseURL}${TARGET_PATH}${LOADING_SHELL_RSC_SEARCH}`,
    shellHeaders,
    "loading-shell RSC",
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

  // The App Page starts streaming before its Suspense child reads cookies(), so
  // the first response must remain private all the way through clean EOF. A
  // public header here would let Workers Cache replay Alice's authenticated
  // HTML to Bob at this exact URL.
  const disclosureUrl = `${baseURL}/dynamic?cache-case=${Date.now()}`;
  const classification = await getResponseAfterPromotion(request, disclosureUrl, {
    accept: "text/html",
    "x-vinext-cacheability-probe": "1",
    "x-vinext-prerender-secret": prerenderSecret,
  });
  await expect(classification.json()).resolves.toMatchObject({
    kind: "app-page",
    pattern: "/dynamic",
    reason: "dynamic API used during render",
    state: "dynamic",
  });
  expect(classification.headers()["cache-control"]).toContain("no-store");
  expect(classification.headers()["cdn-cache-control"]).toBeUndefined();

  const alice = await getResponseAfterPromotion(request, disclosureUrl, {
    accept: "text/html",
    cookie: "session=alice",
  });
  const aliceHtml = await alice.text();
  expect(alice.ok(), JSON.stringify(alice.headers())).toBe(true);
  expect(alice.headers()["cf-cache-status"]).toBe("BYPASS");
  expect(alice.headers()["cache-control"]).toContain("no-store");
  expect(alice.headers()["cdn-cache-control"]).toBeUndefined();
  expect(alice.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  expect((alice.headers().vary ?? "").toLowerCase().split(/,\s*/)).not.toContain("cookie");
  expect(aliceHtml).toContain('data-late-dynamic-viewer="alice"');
  const aliceRenderId = /data-late-dynamic-render-id="([^"]+)"/.exec(aliceHtml)?.[1];
  expect(aliceRenderId).toBeTruthy();

  const bob = await getResponseAfterPromotion(request, disclosureUrl, {
    accept: "text/html",
    cookie: "session=bob",
  });
  const bobHtml = await bob.text();
  expect(bob.ok(), JSON.stringify(bob.headers())).toBe(true);
  expect(bob.headers()["cf-cache-status"]).toBe("BYPASS");
  expect(bob.headers()["cache-control"]).toContain("no-store");
  expect(bob.headers()["cdn-cache-control"]).toBeUndefined();
  expect(bob.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
  expect((bob.headers().vary ?? "").toLowerCase().split(/,\s*/)).not.toContain("cookie");
  expect(bobHtml).toContain('data-late-dynamic-viewer="bob"');
  expect(bobHtml).not.toContain('data-late-dynamic-viewer="alice"');
  const bobRenderId = /data-late-dynamic-render-id="([^"]+)"/.exec(bobHtml)?.[1];
  expect(bobRenderId).toBeTruthy();
  expect(bobRenderId).not.toBe(aliceRenderId);

  const purgeResponse = await request.post(`${baseURL}/api/revalidate-path`, {
    data: { path: TARGET_PATH },
  });
  expect(purgeResponse.ok()).toBe(true);
  expect(await purgeResponse.json()).toEqual({ revalidated: true, target: TARGET_PATH });

  // A purge removes the warmed response body, not the manifest embedded in the
  // promoted Worker. The first completed render must therefore be admitted as
  // a CDN MISS, and subsequent requests must eventually reuse that exact entry.
  const purgeDeadline = Date.now() + 30_000;
  let coldAfterPurge: APIResponse | undefined;
  do {
    const candidate = await getResponseAfterPromotion(request, `${baseURL}${TARGET_PATH}`, {
      accept: "text/html",
    });
    if (candidate.headers()["cf-cache-status"] !== "HIT") {
      coldAfterPurge = candidate;
      break;
    }
    await candidate.dispose();
    await new Promise((resolve) => setTimeout(resolve, PROMOTION_PROBE_INTERVAL_MS));
  } while (Date.now() < purgeDeadline);
  expect(coldAfterPurge, "purged App HTML entry remained a CDN HIT").toBeDefined();
  const coldHeaders = coldAfterPurge!.headers();
  expect(coldAfterPurge!.ok(), JSON.stringify(coldHeaders)).toBe(true);
  expect(coldHeaders["cf-cache-status"]).toBe("MISS");
  expect(coldHeaders["cdn-cache-control"]).toContain("public");
  expect(await coldAfterPurge!.text()).toContain("Prewarm target");

  const reuseDeadline = Date.now() + 30_000;
  let hitAfterPurge: APIResponse | undefined;
  do {
    const candidate = await getResponseAfterPromotion(request, `${baseURL}${TARGET_PATH}`, {
      accept: "text/html",
    });
    if (candidate.headers()["cf-cache-status"] === "HIT") {
      hitAfterPurge = candidate;
      break;
    }
    await candidate.dispose();
    await new Promise((resolve) => setTimeout(resolve, PROMOTION_PROBE_INTERVAL_MS));
  } while (Date.now() < reuseDeadline);
  expect(hitAfterPurge, "cold App HTML cache fill did not become reusable").toBeDefined();
  expect(hitAfterPurge!.ok(), JSON.stringify(hitAfterPurge!.headers())).toBe(true);
  expect(await hitAfterPurge!.text()).toContain("Prewarm target");
});
