import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:4177";
const probeHeader = "X-Vinext-Cacheability-Probe";
const secretHeader = "X-Vinext-Prerender-Secret";

function readPrerenderSecret(): string {
  const manifest = JSON.parse(
    fs.readFileSync("examples/pages-router-cloudflare/dist/server/vinext-server.json", "utf8"),
  ) as { prerenderSecret: string };
  return manifest.prerenderSecret;
}

test("emits the cacheability manifest as part of the Pages Worker artifact", () => {
  const wranglerPath =
    "examples/pages-router-cloudflare/dist/pages_router_cloudflare/wrangler.json";
  const wrangler = JSON.parse(fs.readFileSync(wranglerPath, "utf8")) as { main: string };
  expect(
    fs.existsSync(
      path.join(
        path.dirname(wranglerPath),
        path.dirname(wrangler.main),
        "__vinext_cacheability_manifest.js",
      ),
    ),
  ).toBe(true);
});

test("classifies Pages data contracts inside the staged Worker", async ({ request }) => {
  const headers = {
    [probeHeader]: "1",
    [secretHeader]: readPrerenderSecret(),
  };

  // Ported from Next.js: test/e2e/prerender.test.ts and
  // test/e2e/getserversideprops/test/index.test.ts.
  // https://github.com/vercel/next.js/blob/canary/test/e2e/prerender.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/getserversideprops/test/index.test.ts
  for (const pathname of ["/about", "/revalidate-target"]) {
    const response = await request.get(`${BASE}${pathname}`, { headers });
    expect(response.ok(), pathname).toBe(true);
    await expect(response.json(), pathname).resolves.toMatchObject({
      kind: "pages-page",
      pattern: pathname,
      state: "static-candidate",
      status: 200,
      version: 1,
    });
  }

  for (const pathname of ["/", "/ssr"]) {
    const response = await request.get(`${BASE}${pathname}`, { headers });
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
