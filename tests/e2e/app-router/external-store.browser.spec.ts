import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createExternalStoreFixture } from "../../use-sync-external-store-fixture";
import {
  startChildViteDevServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";

test.setTimeout(60_000);

// Next.js bundles CommonJS client dependencies in dev. Related upstream coverage:
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/client-module-with-package-type/index.test.ts
for (const layout of ["hoisted", "nested"] as const) {
  test(`external store imports hydrate without optimizer reloads (${layout})`, async ({ page }) => {
    const root = await createExternalStoreFixture(layout);
    let server: ChildProductionServer | undefined;
    const errors: string[] = [];
    const documents: string[] = [];
    const reloads: string[] = [];
    const storeRequests: string[] = [];
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", (request) => {
      if (request.resourceType() === "document") documents.push(request.url());
      if (request.url().includes("use-sync-external-store")) storeRequests.push(request.url());
    });
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const message = payload.toString();
        if (message.includes('"type":"full-reload"')) reloads.push(message);
      });
    });

    try {
      // The child signals readiness without an HTTP warmup; the first browser
      // request exercises a cold optimizer cache with real CommonJS exports.
      server = await startChildViteDevServer(root);
      const url = `http://127.0.0.1:${server.port}`;
      expect((await page.goto(url))?.status()).toBe(200);
      for (const index of [0, 1]) {
        await expect(page.locator(`#store-${index}`)).toHaveText("client:0");
        await page.locator(`#store-${index}`).click();
        await expect(page.locator(`#store-${index}`)).toHaveText("client:1");
      }
      await page.locator("#counter").click();
      await expect(page.locator("#counter")).toHaveText("counter:1");

      // Selector entry points are first consumed on another route. They must
      // already be prebundled, without replacing React's shared optimizer chunk.
      await page.locator("#next-page").click();
      await expect(page).toHaveURL(`${url}/selectors`);
      for (const index of [2, 3, 4, 5]) {
        await expect(page.locator(`#store-${index}`)).toHaveText("client:0");
        await page.locator(`#store-${index}`).click();
        await expect(page.locator(`#store-${index}`)).toHaveText("client:1");
      }
      await expect(page.locator("#counter")).toHaveText("counter:1");

      const counterFile = path.join(root, "app/counter.tsx");
      await fs.writeFile(
        counterFile,
        (await fs.readFile(counterFile, "utf8")).replace("counter:{count}", "updated:{count}"),
      );
      await expect(page.locator("#counter")).toHaveText("updated:1");
      expect(documents).toHaveLength(1);
      expect(reloads).toEqual([]);
      expect(storeRequests.length).toBeGreaterThan(0);
      expect(storeRequests.every((request) => request.includes("/.vite/deps/"))).toBe(true);

      await page.reload();
      await expect(page.locator("#store-5")).toHaveText("client:0");
      expect(errors).toEqual([]);
      expect(reloads).toEqual([]);
      expect(JSON.parse(await fs.readFile(path.join(root, "warnings.json"), "utf8"))).toEqual([]);
    } finally {
      if (server) await stopChildProductionServer(server);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
