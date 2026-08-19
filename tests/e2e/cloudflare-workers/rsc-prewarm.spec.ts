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
  body: Buffer;
  requestHeaders: Record<string, string>;
  response: Response;
  url: string;
};

async function observeTargetRsc(page: Page, action: () => Promise<unknown>): Promise<ObservedRsc> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === TARGET_PATH && response.request().headers()["rsc"] === "1";
  });
  await action();
  const response = await responsePromise;
  return {
    body: await response.body(),
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

test("deploy-warmed ISR RSC is reused by every full browser navigation shape", async ({
  baseURL,
  browser,
  request,
}) => {
  test.skip(!baseURL?.startsWith("https://"), "requires a deployed Cloudflare Worker");
  test.setTimeout(120_000);

  const expectedBuildId = fs.readFileSync("examples/workers-cache/dist/server/BUILD_ID", "utf-8");
  await expect
    .poll(
      async () => {
        const readiness = await request.get(`${baseURL}/prewarm/readiness`);
        return (await readiness.text()).includes(expectedBuildId.trim());
      },
      { message: "preview alias did not reach the newly built Worker", timeout: 30_000 },
    )
    .toBe(true);

  const warmerHeaders = { accept: "text/x-component", rsc: "1" };
  const warmedUrl = `${baseURL}${TARGET_PATH}?_rsc`;
  const warmed = await request.get(warmedUrl, { headers: warmerHeaders });
  expect(warmed.ok()).toBe(true);
  expect(warmed.headers()["content-type"]).toContain("text/x-component");
  expect(warmed.headers()["cache-control"]).not.toContain("no-store");
  expect(warmed.headers()["cf-cache-status"]).toBe("HIT");

  const runInFreshPage = async (
    sourcePath: string,
    action?: (page: Page) => Promise<unknown>,
  ): Promise<ObservedRsc> => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      return await observeTargetRsc(page, async () => {
        await page.goto(sourcePath);
        if (action) await action(page);
      });
    } finally {
      await context.close();
    }
  };

  const linkA = await runInFreshPage("/prewarm/link-a");
  expectCanonicalRsc(linkA);

  const linkB = await runInFreshPage("/prewarm/link-b");
  expectCanonicalRsc(linkB);
  expect(linkB.url).toBe(linkA.url);
  expect(linkB.body).toEqual(linkA.body);
  expect(linkB.requestHeaders["rsc"]).toBe(linkA.requestHeaders["rsc"]);
  expect(linkB.requestHeaders["accept"]).toBe(linkA.requestHeaders["accept"]);

  const routerPrefetch = await runInFreshPage("/prewarm/router", (page) =>
    page.getByTestId("router-prefetch").click(),
  );
  expectCanonicalRsc(routerPrefetch);

  const softNavigation = await runInFreshPage("/prewarm/soft", (page) =>
    page.getByTestId("soft-navigation").click(),
  );
  expectCanonicalRsc(softNavigation);

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
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
