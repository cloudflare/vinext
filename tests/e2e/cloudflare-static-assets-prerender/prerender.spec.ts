import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const fixture = path.resolve("tests/e2e/cloudflare-static-assets-prerender/fixture");
const base = "http://localhost:4214";

test("Node prerender packages HTML and RSC into the Static Assets binding", async ({ request }) => {
  const assets = path.join(fixture, "dist/client/_vinext/static-cache");
  expect(fs.existsSync(path.join(assets, "index.json"))).toBe(true);
  const index = JSON.parse(fs.readFileSync(path.join(assets, "index.json"), "utf8"));
  expect(
    Object.values(index).filter((entry: unknown) => (entry as { kind: string }).kind === "html")
      .length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    Object.values(index).filter((entry: unknown) => (entry as { kind: string }).kind === "rsc")
      .length,
  ).toBeGreaterThanOrEqual(2);

  const home = await request.get(base);
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain('<p id="prerender-probe">build-time</p>');
  const about = await request.get(`${base}/about`);
  expect(about.status()).toBe(200);
  expect(await about.text()).toContain("Prebuilt about page");
  const rsc = await request.get(`${base}/about`, { headers: { RSC: "1" } });
  expect(rsc.status()).toBe(200);
  expect(await rsc.text()).toContain("Prebuilt about page");

  // Ported from Next.js: test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/searchparams-static-bailout/searchparams-static-bailout.test.ts
  const queriedHtml = await request.get(`${base}/about?source=nav`);
  expect(queriedHtml.headers()["x-vinext-cache"]).toBe("HIT");
  const queriedRsc = await request.get(`${base}/about?source=nav`, { headers: { RSC: "1" } });
  expect(queriedRsc.headers()["x-vinext-cache"]).toBe("HIT");

  const api = await request.get(`${base}/api/ping`);
  expect(api.status()).toBe(200);
  expect(await api.json()).toEqual({ from: "worker" });
});
