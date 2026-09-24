import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// Ported from Next.js: test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
//
// Runs against the built cf-app-basic Worker: there is no filesystem in
// workerd, so `fetch(new URL(<file>, import.meta.url))` only works when the
// file ships inside the Worker bundle.
const ASSETS_DIR = path.resolve(process.cwd(), "tests/fixtures/cf-app-basic/server-assets");

for (const route of ["/api/edge-blob-assets", "/api/app-edge-blob-assets"]) {
  test.describe(`server URL assets on Workers (${route})`, () => {
    test("allows to fetch text assets", async ({ request }) => {
      const response = await request.get(`${route}?handler=text-file`);
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain("Hello, from text-file.txt!");
    });

    test("allows to fetch image assets", async ({ request }) => {
      const response = await request.get(`${route}?handler=image-file`);
      expect(response.status()).toBe(200);
      const image = fs.readFileSync(path.join(ASSETS_DIR, "image.png"));
      expect(Buffer.from(await response.body()).equals(image)).toBe(true);
    });

    test("allows to fetch assets from node_modules", async ({ request }) => {
      const response = await request.get(`${route}?handler=from-node-module`);
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ name: "react" });
    });

    // Script files fetched as bytes are assets too, whatever the extension.
    for (const [handler, file] of [
      ["js-file", "payload.js"],
      ["ts-file", "payload.ts"],
    ]) {
      test(`allows to fetch ${file} as bytes`, async ({ request }) => {
        const response = await request.get(`${route}?handler=${handler}`);
        expect(response.status()).toBe(200);
        expect(await response.text()).toBe(fs.readFileSync(path.join(ASSETS_DIR, file), "utf8"));
      });
    }
  });
}
