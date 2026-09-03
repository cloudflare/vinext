import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";
import {
  startChildViteDevServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../production-server";

const disabledFixtureSource = path.resolve(
  process.cwd(),
  "tests/fixtures/app-basic/react-strict-mode-disabled",
);

test("enables Strict Mode by default for the App Router", async ({ page }) => {
  await page.goto("/react-strict-mode");
  await waitForAppRouterHydration(page);

  await expect(page.getByTestId("strict-mode-render-count")).toHaveText("2");
});

test.describe("reactStrictMode: false", () => {
  let disabledFixtureRoot: string | undefined;
  let disabledServer: ChildProductionServer | undefined;

  test.beforeAll(async () => {
    disabledFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-strict-mode-disabled-"));
    await fs.cp(disabledFixtureSource, disabledFixtureRoot, { recursive: true });
    const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
    const fixtureNodeModules = path.join(disabledFixtureRoot, "node_modules");
    await fs.mkdir(fixtureNodeModules);
    for (const entry of await fs.readdir(sourceNodeModules)) {
      if (entry.startsWith(".")) continue;
      await fs.symlink(
        path.join(sourceNodeModules, entry),
        path.join(fixtureNodeModules, entry),
        "junction",
      );
    }
    disabledServer = await startChildViteDevServer(disabledFixtureRoot);
  });

  test.afterAll(async () => {
    try {
      if (disabledServer) await stopChildProductionServer(disabledServer);
    } finally {
      if (disabledFixtureRoot) {
        await fs.rm(disabledFixtureRoot, { recursive: true, force: true });
      }
    }
  });

  test("preserves the App Router Strict Mode opt-out", async ({ page }) => {
    if (!disabledServer) throw new Error("Disabled Strict Mode fixture server did not start");
    await page.goto(`http://127.0.0.1:${disabledServer.port}/`);
    await waitForAppRouterHydration(page);

    await expect(page.getByTestId("strict-mode-render-count")).toHaveText("1");
  });
});
