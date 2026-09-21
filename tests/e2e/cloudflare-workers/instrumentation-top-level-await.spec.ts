import { expect, test } from "@playwright/test";
import fs from "node:fs";

test("discovers static params when instrumentation precedes metadata with top-level await", async ({
  request,
}) => {
  const { prerenderSecret } = JSON.parse(
    fs.readFileSync("examples/app-router-cloudflare/dist/server/vinext-server.json", "utf8"),
  ) as { prerenderSecret: string };
  const response = await request.get(
    "/__vinext/prerender/static-params?pattern=%2Fblog%2F%3Aslug",
    { headers: { "x-vinext-prerender-secret": prerenderSecret } },
  );

  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual([
    { slug: "hello-world" },
    { slug: "getting-started" },
  ]);

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain("https://example.com");
});
