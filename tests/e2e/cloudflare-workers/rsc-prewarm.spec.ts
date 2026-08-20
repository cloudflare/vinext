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
  for (const headers of [fullHeaders, shellHeaders]) {
    const response = await request.get(`${baseURL}${TARGET_PATH}?_rsc`, { headers });
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("text/x-component");
    expect(response.headers()["cf-cache-status"]).toBe("HIT");
    expect(response.headers()["x-vinext-rsc-build-id"]).toBe(rscBuildId);
    expect(await response.text()).toContain(buildId);
  }

  const runFresh = async (source: string, run: (page: Page) => Promise<void>) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
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
      const full = await observeRsc(page, () => page.goto("/prewarm/full"));
      expectFull(full);
      await page.getByTestId("link-prefetch").click();
      await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
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
