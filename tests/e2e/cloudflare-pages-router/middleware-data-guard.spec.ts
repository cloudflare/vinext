/**
 * A page guarded only by an exact middleware matcher (`/members`) must stay
 * guarded through its `_next/data` URL. Next.js compiles every matcher with an
 * optional `/_next/data/<buildId>` prefix and `.json` suffix, so the page's data
 * request reaches middleware even when `skipProxyUrlNormalize` hands middleware
 * the raw data URL.
 *
 * Runs in both Worker projects: the production build uses the default config,
 * while cloudflare-pages-router-dev enables `skipProxyUrlNormalize`.
 * Behavior verified against Next.js 16.2.7 with the same matcher and flag.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const RECORD = "synthetic-members-record";
const MEMBER_COOKIE = { Cookie: "members-session=valid" };

function skipsProxyUrlNormalize(): boolean {
  return test.info().project.name === "cloudflare-pages-router-dev";
}

async function getBuildId(request: APIRequestContext): Promise<string> {
  const html = await (await request.get("/ssr")).text();
  const buildId = /"buildId":"([^"]+)"/.exec(html)?.[1];
  expect(buildId).toBeTruthy();
  return buildId!;
}

test.describe("middleware matcher guards Pages data requests", () => {
  test("blocks an anonymous page request", async ({ request }) => {
    const response = await request.get("/members");
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain(RECORD);
  });

  test("blocks an anonymous data request for the guarded page", async ({ request }) => {
    const dataPath = `/_next/data/${await getBuildId(request)}/members.json`;
    const response = await request.get(dataPath);

    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain(RECORD);
    // Middleware observes the raw data URL only when normalization is skipped.
    expect(response.headers()["x-mw-pathname"]).toBe(
      skipsProxyUrlNormalize() ? dataPath : "/members",
    );
  });

  test("does not disclose data for a stale build ID", async ({ request }) => {
    const dataPath = "/_next/data/stale-build-id/members.json";
    const anonymous = await request.get(dataPath);
    // Middleware runs before the stale data 404 and sees the page path unless
    // normalization is skipped.
    expect(anonymous.status()).toBe(403);
    expect(await anonymous.text()).not.toContain(RECORD);
    expect(anonymous.headers()["x-mw-pathname"]).toBe(
      skipsProxyUrlNormalize() ? dataPath : "/members",
    );

    const member = await request.get(dataPath, { headers: MEMBER_COOKIE });
    expect(member.status()).toBe(404);
    expect(await member.text()).not.toContain(RECORD);
  });

  test("serves the page and its data to an authorized member", async ({ request }) => {
    const page = await request.get("/members", { headers: MEMBER_COOKIE });
    expect(page.status()).toBe(200);
    expect(await page.text()).toContain(RECORD);

    const data = await request.get(`/_next/data/${await getBuildId(request)}/members.json`, {
      headers: MEMBER_COOKIE,
    });
    expect(data.status()).toBe(200);
    await expect(data.json()).resolves.toMatchObject({ pageProps: { record: RECORD } });
  });

  test("does not render the record after an anonymous client navigation", async ({ page }) => {
    await page.goto("/ssr");
    await page.waitForFunction(() => Boolean((window as any).next?.router));

    const dataResponse = page.waitForResponse((response) =>
      response.url().includes("/members.json"),
    );
    await page.evaluate(() => (window as any).next.router.push("/members"));
    expect((await dataResponse).status()).toBe(403);

    // The client falls back to a document navigation, which middleware blocks.
    await expect(page.locator("body")).toHaveText("members only");
    await expect(page.getByTestId("members-record")).toHaveCount(0);
  });
});
