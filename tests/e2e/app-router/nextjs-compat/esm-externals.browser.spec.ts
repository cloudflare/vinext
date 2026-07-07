import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { createBuilder } from "vite";
import {
  closeServer,
  createEsmExternalsFixture,
  ESM_EXTERNALS_ROUTE_EXPECTATIONS,
  firstParagraphText,
} from "../../../helpers/esm-externals-fixture.js";

// Match the upstream contract: this test asserts rendered text, not console cleanliness.
test.setTimeout(180_000);

async function writeVinextConfig(fixtureRoot: string): Promise<void> {
  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  await fs.writeFile(
    path.join(fixtureRoot, "vite.config.ts"),
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
});
`,
  );
}

async function assertRenderedRoute(
  page: Page,
  baseUrl: string,
  { kind, route, text }: (typeof ESM_EXTERNALS_ROUTE_EXPECTATIONS)[number],
): Promise<void> {
  const res = await page.request.get(`${baseUrl}${route}`);
  expect(res.status()).toBe(200);
  expect(firstParagraphText(await res.text())).toBe(text);

  await page.goto(`${baseUrl}${route}`, { waitUntil: "load" });
  await page.waitForFunction(() => "__VINEXT_HYDRATED_AT" in window);
  await expect(page.locator(kind === "pages" ? "body p" : "body > p")).toHaveText(text);
}

// Ported from Next.js: test/e2e/esm-externals/esm-externals.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/esm-externals/esm-externals.test.ts
test.describe("esm externals production browser parity", () => {
  test("renders the same SSR HTML and hydrated browser text as the upstream Turbopack fixture", async ({
    page,
  }) => {
    const fixture = await createEsmExternalsFixture();

    try {
      await writeVinextConfig(fixture.root);
      const builder = await createBuilder({
        root: fixture.root,
        configFile: path.join(fixture.root, "vite.config.ts"),
        logLevel: "silent",
      });
      await builder.buildApp();

      const { startProdServer } =
        await import("../../../../packages/vinext/src/server/prod-server.js");
      const started = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir: path.join(fixture.root, "dist"),
        noCompression: true,
      });

      try {
        const baseUrl = `http://127.0.0.1:${started.port}`;

        for (const expectation of ESM_EXTERNALS_ROUTE_EXPECTATIONS) {
          await assertRenderedRoute(page, baseUrl, expectation);
        }
      } finally {
        await closeServer(started.server);
      }
    } finally {
      fixture.cleanup();
    }
  });
});
