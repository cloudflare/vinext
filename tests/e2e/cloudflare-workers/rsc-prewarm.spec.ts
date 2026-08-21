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

const TARGET_PATH = "/prewarm-target";
const LOADING_SHELL_RSC_SEARCH = "?_rsc=9qLBDIU2NgN178cB";
const PROMOTION_STABILITY_WINDOW_MS = 15_000;
const PROMOTION_READINESS_TIMEOUT_MS = 60_000;
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

async function getCanonicalRscAfterPromotion(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
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
    `stale seed Worker remained reachable for canonical RSC request: ${lastSeedStatus ?? "unknown status"}`,
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

function expectCanonical(observed: ObservedRsc): void {
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
  expect(
    observed.response.headers()["cf-cache-status"],
    JSON.stringify({ request: observed.headers, response: observed.response.headers() }),
  ).toBe("HIT");
}

function expectFull(observed: ObservedRsc): void {
  expectCanonical(observed);
  expect(observed.url.search).toBe("?_rsc");
  expect(observed.headers["next-router-prefetch"]).toBeUndefined();
  expect(observed.headers["next-router-segment-prefetch"]).toBeUndefined();
  expect(observed.headers["x-vinext-rsc-render-mode"]).toBeUndefined();
}

function expectLoadingShell(observed: ObservedRsc): void {
  expectCanonical(observed);
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

test("deploy-prewarmed full and loading RSC variants are reused by browser navigation", async ({
  baseURL,
  browser,
  playwright,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  if (!baseURL) throw new Error("deployed test requires a base URL");
  test.setTimeout(180_000);

  const buildId = fs.readFileSync("examples/workers-cache/dist/server/BUILD_ID", "utf-8").trim();
  const rscBuildId = fs
    .readFileSync("examples/workers-cache/dist/server/RSC_BUILD_ID", "utf-8")
    .trim();

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

  const fullResponse = await getCanonicalRscAfterPromotion(
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

  const shellResponse = await getCanonicalRscAfterPromotion(
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

  for (const source of ["/prewarm/link-a", "/prewarm/link-b"]) {
    await runFresh(async (page) => {
      const shell = await observeRsc(page, async () => {
        await gotoCurrentBuild(page, source);
      });
      expectLoadingShell(shell);

      const full = await observeRsc(page, () => page.getByTestId("link-prefetch").click());
      expectFull(full);
      await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
      await expect(page.getByRole("heading", { name: "Prewarm target" })).toBeVisible();
    });
  }

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
    expectFull(full);
    expect(targetRscRequests).toBe(1);
    await page.getByTestId("link-prefetch").click();
    await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
    await expect(page.getByRole("heading", { name: "Prewarm target" })).toBeVisible();
    expect(targetRscRequests).toBe(1);
  });

  await runFresh(async (page) => {
    await gotoCurrentBuild(page, "/prewarm/soft");
    const full = await observeRsc(page, () => page.getByTestId("soft-navigation").click());
    expectFull(full);
    await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
  });

  const dynamic = await request.get(`${baseURL}/dynamic?_rsc`, { headers: fullHeaders });
  expect(dynamic.ok()).toBe(true);
  expect(dynamic.headers()["cache-control"]).toContain("no-store");
  expect(dynamic.headers()["cf-cache-status"]).toBe("BYPASS");
});
