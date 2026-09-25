import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder, createServer } from "vite";

const fixture = path.resolve(process.cwd(), "tests/fixtures/init-css-modules");

// Adapted from Next.js: test/e2e/app-dir/scss/loader-order/loader-order.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/scss/loader-order/loader-order.test.ts
test("init CSS Modules styles are applied in dev and production", async ({ page }) => {
  test.setTimeout(180_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-init-css-modules-browser-"));
  const previousCwd = process.cwd();
  try {
    await fs.cp(fixture, root, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules`),
    });
    await fs.symlink(path.join(fixture, "node_modules"), path.join(root, "node_modules"), "dir");
    const { generateViteConfig } = await import("../../../packages/vinext/src/init.js");
    await fs.writeFile(path.join(root, "vite.config.ts"), generateViteConfig(true, false, true));
    process.chdir(root);

    const dev = await createServer({
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    try {
      await dev.listen();
      const address = dev.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("No dev server address");
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await expect(page.locator("main")).toHaveCSS("color", "rgb(255, 0, 0)");
      await expect(page.locator("main")).toHaveCSS("position", "absolute");
      await expect(page.locator("span")).toHaveCSS("color", "rgb(0, 128, 0)");
    } finally {
      await dev.close();
    }

    const builder = await createBuilder({ root, logLevel: "silent" });
    await builder.buildApp();
    const { startProdServer } = await import("../../../packages/vinext/src/server/prod-server.js");
    const { server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
      noCompression: true,
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No production server address");
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await expect(page.locator("main")).toHaveCSS("color", "rgb(255, 0, 0)");
      await expect(page.locator("main")).toHaveCSS("position", "absolute");
      await expect(page.locator("span")).toHaveCSS("color", "rgb(0, 128, 0)");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    process.chdir(previousCwd);
    await fs.rm(root, { recursive: true, force: true });
  }
});
