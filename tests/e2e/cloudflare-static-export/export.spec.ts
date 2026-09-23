import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test("Cloudflare Vite plugin exports HTML for direct asset serving", async ({ request }) => {
  const wrangler = JSON.parse(
    fs.readFileSync(
      path.resolve("tests/e2e/cloudflare-static-export/fixture/dist/server/wrangler.json"),
      "utf8",
    ),
  ) as { assets?: { directory?: string; run_worker_first?: string[] } };
  expect(wrangler.assets?.directory).toBe("../client");
  expect(wrangler.assets?.run_worker_first).toEqual(["/api/*"]);
  const htmlPath = path.resolve(
    "tests/e2e/cloudflare-static-export/fixture/dist/client/index.html",
  );
  expect(fs.readFileSync(htmlPath, "utf8")).toContain("build-time");
  const response = await request.get("http://localhost:4215/");
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('<p id="export-probe">build-time</p>');
});
