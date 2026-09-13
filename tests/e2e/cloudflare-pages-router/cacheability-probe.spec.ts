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
  const html = await (await request.get(`${BASE}/revalidate-target`)).text();
  const runtimeBuildId = html.match(/"buildId":"([^"]+)"/)?.[1];
  expect(runtimeBuildId).toBeDefined();

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

  for (const pathname of ["/revalidate-target"]) {
    const dataPath = `/_next/data/${runtimeBuildId}${pathname}.json`;
    const response = await request.get(`${BASE}${dataPath}`, { headers });
    expect(response.ok(), dataPath).toBe(true);
    await expect(response.json(), dataPath).resolves.toMatchObject({
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
      // Request-time Pages routes must run to completion during the probe so
      // an explicit public response policy can override their dynamic default.
      status: 200,
      version: 1,
    });
  }

  const ssrDataPath = `/_next/data/${runtimeBuildId}/ssr.json`;
  const ssrData = await request.get(`${BASE}${ssrDataPath}`, { headers });
  expect(ssrData.ok(), ssrDataPath).toBe(true);
  await expect(ssrData.json(), ssrDataPath).resolves.toMatchObject({
    kind: "pages-page",
    pattern: "/ssr",
    state: "dynamic",
    status: 200,
    version: 1,
  });
});
