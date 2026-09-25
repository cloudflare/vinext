import { expect, test, type APIResponse } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { isAppRouterRscRequestForPath, waitForAppRouterHydration } from "../helpers";

const staticCacheDir = path.resolve(
  "examples/static-assets-cache/dist/client/_vinext/static-cache",
);
const buildTimeSource = '<span id="render-source">build-time</span>';

function expectCacheHit(response: APIResponse): void {
  expect(response.status()).toBe(200);
  expect(response.headers()["x-vinext-cache"]).toBe("HIT");
  expect(response.headers()["x-nextjs-cache"]).toBe("HIT");
}

function expectUncached(response: APIResponse): void {
  expect(response.status()).toBe(200);
  expect(response.headers()["x-vinext-cache"]).toBeUndefined();
  expect(response.headers()["x-nextjs-cache"]).toBeUndefined();
}

test("build packages prerendered HTML, RSC, and metadata into Static Assets", ({ baseURL }) => {
  test.skip(Boolean(process.env.VINEXT_E2E_BASE_URL), "inspects the local build output");
  expect(baseURL).toBeDefined();
  const index = JSON.parse(
    fs.readFileSync(path.join(staticCacheDir, "index.json"), "utf8"),
  ) as Record<string, { kind: string }>;
  const kinds = Object.values(index).map((entry) => entry.kind);
  // `/`, `/about`, both generateStaticParams posts, and the prerendered not-found page.
  expect(kinds.filter((kind) => kind === "html")).toHaveLength(5);
  expect(kinds.filter((kind) => kind === "rsc")).toHaveLength(4);
  expect(kinds.filter((kind) => kind === "route")).toHaveLength(1);
  for (const [id, entry] of Object.entries(index)) {
    expect(fs.existsSync(path.join(staticCacheDir, `${id}.${entry.kind}`))).toBe(true);
  }
});

test("prerendered HTML is a Static Assets cache hit", async ({ request }) => {
  for (const [pathname, heading] of [
    ["/", "vinext Static Assets cache"],
    ["/about", "Prebuilt about page"],
    ["/posts/first", "Post: first"],
    ["/posts/second", "Post: second"],
  ]) {
    const response = await request.get(pathname, { maxRedirects: 0 });
    expectCacheHit(response);
    expect(response.headers()["content-type"]).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(`<h1>${heading}</h1>`);
    expect(html).toContain(buildTimeSource);
  }
});

test("prerendered RSC payloads are Static Assets cache hits", async ({ request }) => {
  for (const [pathname, heading] of [
    ["/", "vinext Static Assets cache"],
    ["/about", "Prebuilt about page"],
    ["/posts/first", "Post: first"],
    ["/posts/second", "Post: second"],
  ]) {
    const response = await request.get(`${pathname}?_rsc`, {
      headers: { RSC: "1" },
      maxRedirects: 0,
    });
    expectCacheHit(response);
    expect(response.headers()["content-type"]).toContain("text/x-component");
    const payload = await response.text();
    expect(payload).toContain(heading);
    expect(payload).toContain("build-time");
  }
});

test("prerendered metadata routes are Static Assets cache hits", async ({ request }) => {
  const response = await request.get("/robots.txt", { maxRedirects: 0 });
  expectCacheHit(response);
  expect(response.headers()["content-type"]).toContain("text/plain");
  expect(await response.text()).toContain("User-Agent: *");
});

test("soft navigation reads the prerendered RSC payload from Static Assets", async ({ page }) => {
  const aboutRsc = page.waitForResponse((response) =>
    isAppRouterRscRequestForPath(response.request(), "/about"),
  );
  await page.goto("/");
  await waitForAppRouterHydration(page);
  await page.evaluate(() => Reflect.set(window, "__staticAssetsNoReload", true));

  await page.getByRole("link", { name: "About" }).click();
  const response = await aboutRsc;
  expect(response.status()).toBe(200);
  expect(response.headers()["x-vinext-cache"]).toBe("HIT");

  await expect(page.getByRole("heading", { name: "Prebuilt about page" })).toBeVisible();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.locator("#render-source")).toHaveText("build-time");
  expect(await page.evaluate(() => Reflect.get(window, "__staticAssetsNoReload"))).toBe(true);
});

test("routes that were not prerendered render in the Worker", async ({ request }) => {
  const first = await request.get("/dynamic", { maxRedirects: 0 });
  expectUncached(first);
  const firstHtml = await first.text();
  expect(firstHtml).toContain('<span id="render-source">runtime</span>');
  const second = await request.get("/dynamic", { maxRedirects: 0 });
  expectUncached(second);
  const requestId = /<span id="request-id">([^<]+)<\/span>/;
  expect(firstHtml.match(requestId)?.[1]).toBeTruthy();
  expect((await second.text()).match(requestId)?.[1]).not.toBe(firstHtml.match(requestId)?.[1]);

  const firstPing = await request.get("/api/ping");
  expectUncached(firstPing);
  const secondPing = await request.get("/api/ping");
  const firstBody = (await firstPing.json()) as { from: string; requestId: string };
  const secondBody = (await secondPing.json()) as { from: string; requestId: string };
  expect(firstBody.from).toBe("worker");
  expect(secondBody.requestId).not.toBe(firstBody.requestId);
});

test("query variants of prerendered routes still render the page", async ({ request }) => {
  const html = await request.get("/about?source=nav", { maxRedirects: 0 });
  expect(html.status()).toBe(200);
  expect(await html.text()).toContain("<h1>Prebuilt about page</h1>");
  const rsc = await request.get("/about?source=nav&_rsc", {
    headers: { RSC: "1" },
    maxRedirects: 0,
  });
  expect(rsc.status()).toBe(200);
  expect(await rsc.text()).toContain("Prebuilt about page");
});

test("packaged cache artifacts are not publicly served", async ({ request }) => {
  const index = await request.get("/_vinext/static-cache/index.json", { maxRedirects: 0 });
  expect(index.status()).toBe(404);
  expect(index.headers()["content-type"]).not.toContain("application/json");

  const missing = await request.get("/missing-page", { maxRedirects: 0 });
  expect(missing.status()).toBe(404);
});
