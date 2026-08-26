import { expect, test } from "@playwright/test";
import fs from "node:fs";

const probeHeader = "X-Vinext-Cacheability-Probe";
const secretHeader = "X-Vinext-Prerender-Secret";

function prerenderSecret(): string {
  const manifest = JSON.parse(
    fs.readFileSync("tests/fixtures/ppr-impact-demo/dist/server/vinext-server.json", "utf8"),
  ) as { prerenderSecret: string };
  return manifest.prerenderSecret;
}

test("classifies Pages Router data contracts inside the staged Worker", async ({ request }) => {
  const headers = { [probeHeader]: "1", [secretHeader]: prerenderSecret() };

  // Ported from Next.js: test/e2e/prerender.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
  for (const [pathname, pattern] of [
    ["/cacheability-pages/isr", "/cacheability-pages/isr"],
    ["/cacheability-pages/posts/known", "/cacheability-pages/posts/:slug"],
  ] as const) {
    const response = await request.get(pathname, { headers });
    expect(response.ok(), pathname).toBe(true);
    await expect(response.json(), pathname).resolves.toMatchObject({
      kind: "pages-page",
      pattern,
      state: "static-candidate",
      status: 200,
      version: 1,
    });
  }

  for (const pathname of ["/cacheability-pages/gssp", "/cacheability-pages/get-initial-props"]) {
    const response = await request.get(pathname, { headers });
    expect(response.ok(), pathname).toBe(true);
    await expect(response.json(), pathname).resolves.toMatchObject({
      kind: "pages-page",
      pattern: pathname,
      state: "dynamic",
      status: 204,
      version: 1,
    });
  }
});

test("admits only exact manifest-backed Pages Router responses", async ({ request }) => {
  for (const pathname of ["/cacheability-pages/isr", "/cacheability-pages/posts/known"]) {
    const response = await request.get(pathname, { headers: { Accept: "text/html" } });
    expect(response.status(), pathname).toBe(200);
    expect(response.headers()["cdn-cache-control"], pathname).toContain("max-age=60");
  }

  for (const pathname of [
    "/cacheability-pages/gssp",
    "/cacheability-pages/get-initial-props",
    "/cacheability-pages/isr?unlisted=1",
    "/cacheability-pages/posts/unknown",
  ]) {
    const response = await request.get(pathname, { headers: { Accept: "text/html" } });
    expect(response.headers()["cache-control"], pathname).toContain("no-store");
    expect(response.headers()["cdn-cache-control"], pathname).toBeUndefined();
  }
});
