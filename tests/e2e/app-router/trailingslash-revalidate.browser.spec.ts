import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";
import { waitForAppRouterHydration } from "../helpers";

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/app-trailing-slash-isr");

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: ChildProductionServer;
};

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");
  await fs.mkdir(targetNodeModules, { recursive: true });
  for (const entry of await fs.readdir(sourceNodeModules, {
    withFileTypes: true,
  })) {
    if (entry.name === ".vite" || entry.name === ".vite-temp") continue;
    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
}

async function buildAndServeFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ts-revalidate-"));
  await fs.cp(FIXTURE_DIR, fixtureRoot, { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);

  const vinext = (await import("../../../packages/vinext/src/index.js")).default;
  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: false,
    plugins: [vinext({ appDir: fixtureRoot })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const server = await startChildProductionServer(fixtureRoot);
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    fixtureRoot,
    server,
  };
}

let app: ProductionApp;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  app = await buildAndServeFixture();
});

test.afterAll(async () => {
  await stopChildProductionServer(app.server);
  await fs.rm(app.fixtureRoot, { recursive: true, force: true });
});

test.setTimeout(60_000);

// Ported from Next.js: test/e2e/app-dir/trailingslash/trailingslash.test.ts
for (const withSlash of [true, false]) {
  test(`should revalidate a page with generated static params (withSlash=${withSlash})`, async ({
    page,
  }) => {
    await page.goto(`${app.baseUrl}/en`);
    await waitForAppRouterHydration(page);

    const initialGeneratedAt = await page.locator("#generated-at").textContent();
    expect(initialGeneratedAt).toBeTruthy();
    expect(initialGeneratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    await page.reload();
    await waitForAppRouterHydration(page);
    const refreshedGeneratedAt = await page.locator("#generated-at").textContent();

    await expect(async () => {
      await page.reload();
      await waitForAppRouterHydration(page);
      const refreshedAgainGeneratedAt = await page.locator("#generated-at").textContent();
      expect(refreshedAgainGeneratedAt).toBe(refreshedGeneratedAt);
    }).toPass({ timeout: 10_000 });

    const buttonId = withSlash ? "revalidate-button-with-slash" : "revalidate-button-no-slash";
    await page.locator(`#${buttonId}`).click();

    await expect(page.locator("#revalidate-result")).toContainText("Revalidated");

    await expect(async () => {
      await page.reload();
      await waitForAppRouterHydration(page);
      const generatedAt = await page.locator("#generated-at").textContent();
      expect(generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(generatedAt).not.toBe(initialGeneratedAt);
    }).toPass({ timeout: 30_000, intervals: [1000] });
  });
}
