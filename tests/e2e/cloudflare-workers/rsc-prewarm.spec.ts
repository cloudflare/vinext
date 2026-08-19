import { expect, test, type Page, type Response } from "@playwright/test";
import fs from "node:fs";

const TARGET_PATH = "/cached/intro";
const VARIANT_HEADERS = [
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-router-state-tree",
  "next-url",
  "x-vinext-client-reuse-manifest",
  "x-vinext-rsc-state-fingerprint",
] as const;

type ObservedRsc = {
  requestHeaders: Record<string, string>;
  response: Response;
  url: string;
};

test.describe.configure({ retries: 0 });

async function waitForStableDeployment(page: Page, expectedBuildId: string): Promise<void> {
  let consecutiveCurrentBuilds = 0;
  await expect
    .poll(
      async () => {
        await page.goto(`/prewarm/readiness?probe=${Date.now()}-${Math.random()}`);
        const buildId = await page.getByTestId("build-id").textContent();
        consecutiveCurrentBuilds = buildId === expectedBuildId ? consecutiveCurrentBuilds + 1 : 0;
        return consecutiveCurrentBuilds;
      },
      {
        message: "deployment did not converge on the newly built Worker",
        timeout: 30_000,
      },
    )
    .toBeGreaterThanOrEqual(3);
}

async function observeTargetRsc(page: Page, action: () => Promise<unknown>): Promise<ObservedRsc> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === TARGET_PATH && response.request().headers()["rsc"] === "1";
  });
  await action();
  const response = await responsePromise;
  expect(await response.finished()).toBeNull();
  return {
    requestHeaders: response.request().headers(),
    response,
    url: response.url(),
  };
}

function expectCanonicalRsc(observed: ObservedRsc): void {
  const url = new URL(observed.url);
  expect(url.pathname).toBe(TARGET_PATH);
  expect(url.search).toBe("?_rsc");
  expect(observed.requestHeaders["accept"]).toBe("text/x-component");
  expect(observed.requestHeaders["rsc"]).toBe("1");
  for (const header of VARIANT_HEADERS) {
    expect(observed.requestHeaders[header]).toBeUndefined();
  }
  expect(observed.response.headers()["cf-cache-status"]).toBe("HIT");
}

async function expectSoftNavigationCommit(
  page: Page,
  expectedBuildId: string,
  targetDocumentRequests: string[],
  targetRscRequests: string[],
): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
  await expect(page.getByRole("heading", { name: "Post: intro" })).toBeVisible();
  await expect(page.getByTestId("build-id")).toHaveText(expectedBuildId);
  expect(targetDocumentRequests).toEqual([]);
  expect(targetRscRequests).toHaveLength(1);
}

test("deploy-warmed ISR RSC is reused by every full browser navigation shape", async ({
  baseURL,
  browser,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  test.setTimeout(120_000);

  const expectedBuildId = fs
    .readFileSync("examples/workers-cache/dist/server/BUILD_ID", "utf-8")
    .trim();
  const expectedRscBuildId = fs
    .readFileSync("examples/workers-cache/dist/server/RSC_BUILD_ID", "utf-8")
    .trim();
  await expect
    .poll(
      async () => {
        const readiness = await request.get(`${baseURL}/prewarm/readiness`);
        return (await readiness.text()).includes(expectedBuildId);
      },
      { message: "deployment did not reach the newly built Worker", timeout: 30_000 },
    )
    .toBe(true);

  const warmerHeaders = { accept: "text/x-component", rsc: "1" };
  const warmedUrl = `${baseURL}${TARGET_PATH}?_rsc`;
  const warmed = await request.get(warmedUrl, { headers: warmerHeaders });
  expect(warmed.ok()).toBe(true);
  expect(warmed.headers()["content-type"]).toContain("text/x-component");
  expect(warmed.headers()["cache-control"]).not.toContain("no-store");
  expect(warmed.headers()["cf-cache-status"]).toBe("HIT");
  expect(warmed.headers()["x-vinext-rsc-build-id"]).toBe(expectedRscBuildId);
  expect(await warmed.text()).toContain(expectedBuildId);

  const withFreshPage = async (
    run: (
      page: Page,
      targetDocumentRequests: string[],
      targetRscRequests: string[],
    ) => Promise<void>,
  ): Promise<void> => {
    const context = await browser.newContext();
    try {
      const readinessPage = await context.newPage();
      try {
        await waitForStableDeployment(readinessPage, expectedBuildId);
      } finally {
        await readinessPage.close();
      }
      const page = await context.newPage();
      const targetDocumentRequests: string[] = [];
      const targetRscRequests: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === TARGET_PATH && request.resourceType() === "document") {
          targetDocumentRequests.push(request.url());
        }
        if (url.pathname === TARGET_PATH && request.headers()["rsc"] === "1") {
          targetRscRequests.push(request.url());
        }
      });
      await run(page, targetDocumentRequests, targetRscRequests);
    } finally {
      await context.close();
    }
  };

  let firstLinkPrefetch: ObservedRsc | null = null;
  for (const sourcePath of ["/prewarm/link-a", "/prewarm/link-b"]) {
    await withFreshPage(async (page, targetDocumentRequests, targetRscRequests) => {
      const observed = await observeTargetRsc(page, () => page.goto(sourcePath));
      await expect(page.getByTestId("build-id")).toHaveText(expectedBuildId);
      expectCanonicalRsc(observed);
      if (firstLinkPrefetch) {
        expect(observed.url).toBe(firstLinkPrefetch.url);
        expect(observed.requestHeaders["rsc"]).toBe(firstLinkPrefetch.requestHeaders["rsc"]);
        expect(observed.requestHeaders["accept"]).toBe(firstLinkPrefetch.requestHeaders["accept"]);
      } else {
        firstLinkPrefetch = observed;
      }
      await page.getByTestId("link-prefetch").click();
      await expectSoftNavigationCommit(
        page,
        expectedBuildId,
        targetDocumentRequests,
        targetRscRequests,
      );
    });
  }

  await withFreshPage(async (page, targetDocumentRequests, targetRscRequests) => {
    await page.goto("/prewarm/router");
    await expect(page.getByTestId("build-id")).toHaveText(expectedBuildId);
    const observed = await observeTargetRsc(page, () =>
      page.getByTestId("router-prefetch").click(),
    );
    expectCanonicalRsc(observed);
    await page.getByTestId("router-navigate").click();
    await expectSoftNavigationCommit(
      page,
      expectedBuildId,
      targetDocumentRequests,
      targetRscRequests,
    );
  });

  await withFreshPage(async (page, targetDocumentRequests, targetRscRequests) => {
    await page.goto("/prewarm/soft");
    await expect(page.getByTestId("build-id")).toHaveText(expectedBuildId);
    const observed = await observeTargetRsc(page, () =>
      page.getByTestId("soft-navigation").click(),
    );
    expectCanonicalRsc(observed);
    await expectSoftNavigationCommit(
      page,
      expectedBuildId,
      targetDocumentRequests,
      targetRscRequests,
    );
  });

  await withFreshPage(async (page, targetDocumentRequests, targetRscRequests) => {
    await page.route("**/vinext-rsc-prewarm.json", async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ response });
    });
    await page.goto("/prewarm/soft");
    await expect(page.getByTestId("build-id")).toHaveText(expectedBuildId);
    const observed = await observeTargetRsc(page, () =>
      page.getByTestId("soft-navigation").click(),
    );
    expectCanonicalRsc(observed);
    await expectSoftNavigationCommit(
      page,
      expectedBuildId,
      targetDocumentRequests,
      targetRscRequests,
    );
  });

  await withFreshPage(async (page, targetDocumentRequests, targetRscRequests) => {
    await page.route("**/vinext-rsc-prewarm.json", (route) => route.abort());
    await page.goto("/prewarm/soft");
    await expect(page.getByTestId("build-id")).toHaveText(expectedBuildId);
    const observed = await observeTargetRsc(page, () =>
      page.getByTestId("soft-navigation").click(),
    );

    await expect(page).toHaveURL(new RegExp(`${TARGET_PATH}$`));
    await expect(page.getByRole("heading", { name: "Post: intro" })).toBeVisible();
    await expect(page.getByTestId("build-id")).toHaveText(expectedBuildId);
    expect(new URL(observed.url).searchParams.get("_rsc")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(observed.requestHeaders["x-vinext-rsc-state-fingerprint"]).toBeDefined();
    expect(targetRscRequests).toHaveLength(1);
    expect(targetDocumentRequests).toEqual([]);
  });

  const context = await browser.newContext();
  try {
    const readinessPage = await context.newPage();
    try {
      await waitForStableDeployment(readinessPage, expectedBuildId);
    } finally {
      await readinessPage.close();
    }
    const page = await context.newPage();
    const dynamicResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/dynamic" && response.request().headers()["rsc"] === "1";
    });
    await page.goto("/prewarm/dynamic");
    const dynamicResponse = await dynamicResponsePromise;
    const dynamicUrl = new URL(dynamicResponse.url());
    expect(dynamicUrl.searchParams.get("_rsc")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(dynamicResponse.headers()["cache-control"]).toContain("no-store");
    expect(dynamicResponse.headers()["cf-cache-status"]).toBe("BYPASS");
  } finally {
    await context.close();
  }
});
