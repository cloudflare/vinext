/**
 * Server component errors that reject the document's shell, in production.
 *
 * Like Next.js, vinext answers with the `__next_error__` error document,
 * carrying the payload of the render that failed. The browser renders that
 * payload, and the error boundary above the component that threw catches the
 * error: a segment's error.tsx sits inside its layout, so a layout's error
 * goes to the boundary above it, and global-error for the root layout.
 *
 * Ported from Next.js:
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/layout-error/index.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../../fixtures";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../../production-server";

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/app-layout-error");

async function buildAndServeFixture(): Promise<{
  baseUrl: string;
  fixtureRoot: string;
  server: ChildProductionServer;
}> {
  // Build a copy, so the build output stays out of the checked-in fixture.
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-layout-error-"));
  await fs.cp(FIXTURE_DIR, fixtureRoot, { recursive: true });
  await fs.symlink(
    path.resolve(process.cwd(), "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "dir",
  );

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

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();

  const server = await startChildProductionServer(fixtureRoot);
  return { baseUrl: `http://127.0.0.1:${server.port}`, fixtureRoot, server };
}

test.setTimeout(90_000);

test("renders the error boundary above a server component that threw in the shell", async ({
  page,
  consoleErrors,
}) => {
  const app = await buildAndServeFixture();

  try {
    const cases = [
      { header: "x-vinext-throw-root-layout", path: "/", boundary: "#global-error" },
      // A server component the root layout renders, outside its children.
      { header: "x-vinext-throw-root-header", path: "/nested", boundary: "#global-error" },
      { header: "x-vinext-throw-nested-layout", path: "/nested", boundary: "#root-error" },
      { header: "x-vinext-throw-nested-page", path: "/nested", boundary: "#nested-error" },
    ];
    // Only the document request throws: extra HTTP headers would also reach
    // the browser's favicon request, whose not-found page renders the layouts.
    const throwOnNavigation = async (header: string) => {
      await page.unrouteAll();
      await page.route(`${app.baseUrl}/**`, (route, request) =>
        route.continue(
          request.isNavigationRequest()
            ? { headers: { ...request.headers(), [header]: "1" } }
            : undefined,
        ),
      );
    };
    for (const { header, path: pathname, boundary } of cases) {
      await throwOnNavigation(header);
      const response = await page.goto(`${app.baseUrl}${pathname}`, { waitUntil: "load" });
      expect(response?.status(), header).toBe(500);
      await expect(page.locator(boundary), header).toBeVisible();
      await expect(page.locator("#root-layout"), header).toHaveCount(
        boundary === "#global-error" ? 0 : 1,
      );
    }

    // Production sanitizes the message, and global-error gets the digest the
    // server reported the error with.
    await throwOnNavigation("x-vinext-throw-root-layout");
    await page.goto(`${app.baseUrl}/`, { waitUntil: "load" });
    await expect(page.locator("#global-error-message")).toContainText("Minified React error #441");
    await expect(page.locator("#global-error-digest")).toHaveText(/^\w+$/);

    // React logs each error a boundary catches, and the browser logs the 500,
    // and the 404 of the favicon the fixture doesn't have.
    const unexpectedErrors = consoleErrors.filter(
      (message) =>
        !message.includes("Minified React error #441") &&
        !message.includes("Failed to load resource: the server responded with a status of 500") &&
        !message.includes("Failed to load resource: the server responded with a status of 404") &&
        !message.startsWith("The above error occurred in a React component"),
    );
    expect(unexpectedErrors).toEqual([]);
    consoleErrors.length = 0;
  } finally {
    try {
      await stopChildProductionServer(app.server);
    } finally {
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  }
});
