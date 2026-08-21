import { expect, test, type Page, type Response } from "@playwright/test";
import fs from "node:fs";

const TARGET_PATH = "/cached/intro";

type ObservedRsc = {
  headers: Record<string, string>;
  response: Response;
  url: URL;
};

test.describe.configure({ retries: 0 });

async function observeRsc(page: Page, action: () => Promise<unknown>): Promise<ObservedRsc> {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return new URL(response.url()).pathname === TARGET_PATH && request.headers().rsc === "1";
  });
  await action();
  const response = await responsePromise;
  return {
    headers: response.request().headers(),
    response,
    url: new URL(response.url()),
  };
}

function expectBareCanonical(observed: ObservedRsc): void {
  expect(observed.url.pathname).toBe(TARGET_PATH);
  expect(observed.url.search).toBe("?_rsc");
  expect(observed.headers.accept).toBe("text/x-component");
  expect(observed.headers.rsc).toBe("1");
  expect(observed.headers["next-router-state-tree"]).toBeUndefined();
  expect(observed.headers["next-url"]).toBeUndefined();
  expect(observed.headers["x-vinext-rsc-state-fingerprint"]).toBeUndefined();
  expect(observed.response.headers()["cf-cache-status"]).toBe("HIT");
}

function expectFull(observed: ObservedRsc): void {
  expectBareCanonical(observed);
  expect(observed.headers["next-router-prefetch"]).toBeUndefined();
  expect(observed.headers["next-router-segment-prefetch"]).toBeUndefined();
  expect(observed.headers["x-vinext-rsc-render-mode"]).toBeUndefined();
}

function expectLoadingShell(observed: ObservedRsc): void {
  expectBareCanonical(observed);
  expect(observed.headers["next-router-prefetch"]).toBe("1");
  expect(observed.headers["next-router-segment-prefetch"]).toBe("1");
  expect(observed.headers["x-vinext-rsc-render-mode"]).toBe("prefetch-loading-shell");
}

test("deploy-prewarmed full and loading RSC variants are reused by browser navigation", async ({
  baseURL,
  browser,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  test.setTimeout(120_000);

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

  // Promotion can take a moment to route ordinary requests to the new Worker.
  // Poll a dedicated no-store API route so this cannot fill either target RSC
  // cache entry before asserting that the deploy warmup is reused.
  await expect(async () => {
    const response = await request.get(`${baseURL}/api/prewarm-version`);
    expect(response.ok()).toBe(true);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(await response.json()).toEqual({ buildId });
    console.log(
      `version probe: cache=${response.headers()["cf-cache-status"] ?? "missing"} ray=${response.headers()["cf-ray"] ?? "missing"}`,
    );
  }).toPass({ timeout: 30_000 });

  const nodeFullFeatured = await fetch(`${baseURL}/cached/featured?_rsc`, {
    headers: fullHeaders,
  });
  await nodeFullFeatured.arrayBuffer();
  const playwrightFullIntro = await request.get(`${baseURL}${TARGET_PATH}?_rsc`, {
    headers: fullHeaders,
  });
  await playwrightFullIntro.body();
  const nodeShellIntro = await fetch(`${baseURL}${TARGET_PATH}?_rsc`, {
    headers: shellHeaders,
  });
  await nodeShellIntro.arrayBuffer();
  const playwrightShellFeatured = await request.get(`${baseURL}/cached/featured?_rsc`, {
    headers: shellHeaders,
  });
  await playwrightShellFeatured.body();
  const clientDiagnostics = [
    [
      "node full featured",
      nodeFullFeatured.headers.get("cf-cache-status"),
      nodeFullFeatured.headers.get("cf-ray"),
    ],
    [
      "playwright full intro",
      playwrightFullIntro.headers()["cf-cache-status"],
      playwrightFullIntro.headers()["cf-ray"],
    ],
    [
      "node shell intro",
      nodeShellIntro.headers.get("cf-cache-status"),
      nodeShellIntro.headers.get("cf-ray"),
    ],
    [
      "playwright shell featured",
      playwrightShellFeatured.headers()["cf-cache-status"],
      playwrightShellFeatured.headers()["cf-ray"],
    ],
  ] as const;
  for (const [label, status, ray] of clientDiagnostics) {
    console.log(`${label}: cache=${status ?? "missing"} ray=${ray ?? "missing"}`);
  }
  expect(clientDiagnostics.map(([, status]) => status)).toEqual(["HIT", "HIT", "HIT", "HIT"]);

  const fullResponse = await request.get(`${baseURL}${TARGET_PATH}?_rsc`, {
    headers: fullHeaders,
  });
  const fullResponseHeaders = fullResponse.headers();
  console.log(
    `full RSC verify: cache=${fullResponseHeaders["cf-cache-status"] ?? "missing"} ray=${fullResponseHeaders["cf-ray"] ?? "missing"}`,
  );
  expect(fullResponse.ok()).toBe(true);
  expect(fullResponseHeaders["content-type"]).toContain("text/x-component");
  expect(fullResponseHeaders["x-vinext-rsc-build-id"]).toBe(rscBuildId);
  expect(
    fullResponseHeaders["cf-cache-status"],
    `full RSC response headers: ${JSON.stringify(fullResponseHeaders)}`,
  ).toBe("HIT");
  const fullBody = await fullResponse.text();
  expect(fullBody).toContain(buildId);
  expect(fullBody).toContain("Post: intro");

  const shellResponse = await request.get(`${baseURL}${TARGET_PATH}?_rsc`, {
    headers: shellHeaders,
  });
  const shellResponseHeaders = shellResponse.headers();
  console.log(
    `loading RSC verify: cache=${shellResponseHeaders["cf-cache-status"] ?? "missing"} ray=${shellResponseHeaders["cf-ray"] ?? "missing"}`,
  );
  expect(shellResponse.ok()).toBe(true);
  expect(shellResponseHeaders["content-type"]).toContain("text/x-component");
  expect(shellResponseHeaders["x-vinext-rsc-build-id"]).toBe(rscBuildId);
  expect(
    shellResponseHeaders["cf-cache-status"],
    `loading-shell RSC response headers: ${JSON.stringify(shellResponseHeaders)}`,
  ).toBe("HIT");
  const shellBody = await shellResponse.text();
  expect(shellBody).toContain(buildId);
  expect(shellBody).toContain("cached-loading-shell");
  expect(shellBody).not.toContain("Post: intro");
  expect(shellBody).not.toBe(fullBody);

  const waitForBrowserCurrentBuild = async (page: Page) => {
    await expect(async () => {
      const response = await page.goto("/prewarm/soft");
      expect(response?.ok()).toBe(true);
      await expect(page.getByTestId("build-id")).toHaveText(buildId, { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  };

  const runFresh = async (source: string, run: (page: Page) => Promise<void>) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await waitForBrowserCurrentBuild(page);
      await page.goto(source);
      await expect(page.getByTestId("build-id")).toHaveText(buildId);
      await run(page);
    } finally {
      await context.close();
    }
  };

  for (const source of ["/prewarm/link-a", "/prewarm/link-b"]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await waitForBrowserCurrentBuild(page);
      const shell = await observeRsc(page, () => page.goto(source));
      expectLoadingShell(shell);
      await expect(page.getByTestId("build-id")).toHaveText(buildId);

      const full = await observeRsc(page, () => page.getByTestId("link-prefetch").click());
      expectFull(full);
      await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
      await expect(page.getByRole("heading", { name: "Post: intro" })).toBeVisible();
    } finally {
      await context.close();
    }
  }

  {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await waitForBrowserCurrentBuild(page);
      let targetRscRequests = 0;
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === TARGET_PATH && request.headers().rsc === "1") {
          targetRscRequests++;
        }
      });
      const full = await observeRsc(page, () => page.goto("/prewarm/full"));
      expectFull(full);
      expect(targetRscRequests).toBe(1);
      await page.getByTestId("link-prefetch").click();
      await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
      await expect(page.getByRole("heading", { name: "Post: intro" })).toBeVisible();
      expect(targetRscRequests).toBe(1);
    } finally {
      await context.close();
    }
  }

  await runFresh("/prewarm/soft", async (page) => {
    const full = await observeRsc(page, () => page.getByTestId("soft-navigation").click());
    expectFull(full);
    await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
  });

  const dynamic = await request.get(`${baseURL}/dynamic?_rsc`, { headers: fullHeaders });
  expect(dynamic.ok()).toBe(true);
  expect(dynamic.headers()["cache-control"]).toContain("no-store");
  expect(dynamic.headers()["cf-cache-status"]).toBe("BYPASS");
});
