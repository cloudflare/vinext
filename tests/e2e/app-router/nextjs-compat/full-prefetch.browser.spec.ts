import fs from "node:fs/promises";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

type FullPrefetchState = {
  release: (() => void) | null;
  requestCount: number;
  responseText: string;
  routerPrefetchHeader: string | null;
  routerStateHeader: string | null;
};

type FullPrefetchWindow = Window & {
  __VINEXT_FULL_PREFETCH_TEST__?: FullPrefetchState;
};

const requireFromVinextPackage = createRequire(
  path.resolve(process.cwd(), "packages/vinext/package.json"),
);

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");

  await fs.mkdir(targetNodeModules, { recursive: true });
  for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite" || entry.name === ".vite-temp") continue;
    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
}

async function writeFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  const targetDir = path.join(appDir, "target");
  const settledTargetDir = path.join(appDir, "settled-target");
  const noPrefetchTargetDir = path.join(appDir, "no-prefetch-target");
  await Promise.all([
    fs.mkdir(targetDir, { recursive: true }),
    fs.mkdir(settledTargetDir, { recursive: true }),
    fs.mkdir(noPrefetchTargetDir, { recursive: true }),
  ]);
  await linkFixtureNodeModules(fixtureRoot);

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "page.tsx"),
    `import Link from "next/link";

export default function HomePage() {
  return <>
    <Link href="/target" id="full-prefetch-link" prefetch={true}>Target</Link>
    <Link href="/settled-target" id="settled-prefetch-link" prefetch={true}>Settled target</Link>
    <Link href="/no-prefetch-target" id="no-prefetch-link" prefetch={false}>No prefetch target</Link>
  </>;
}
`,
  );
  await fs.writeFile(
    path.join(targetDir, "loading.tsx"),
    `export default function Loading() {
  return <p id="target-loading">Full prefetch loading shell</p>;
}
`,
  );
  await fs.writeFile(
    path.join(targetDir, "page.tsx"),
    `export default function TargetPage() {
  return <h1 id="target-content">Full prefetch page content</h1>;
}
`,
  );
  await fs.writeFile(
    path.join(settledTargetDir, "page.tsx"),
    `export default function SettledTargetPage() {
  return <h1 id="settled-target-content">Settled prefetch page content</h1>;
}
`,
  );
  await fs.writeFile(
    path.join(noPrefetchTargetDir, "page.tsx"),
    `export default function NoPrefetchTargetPage() {
  return <h1 id="no-prefetch-target-content">No prefetch page content</h1>;
}
`,
  );

  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  const reactPluginSource = requireFromVinextPackage.resolve("@vitejs/plugin-react");
  await fs.writeFile(
    path.join(fixtureRoot, "vite.config.ts"),
    `import { defineConfig } from "vite";
import react from ${JSON.stringify(pathToFileURL(reactPluginSource).href)};
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({
  plugins: [react(), vinext({ appDir: import.meta.dirname, react: false })],
});
`,
  );
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

test.setTimeout(90_000);

test("explicit full prefetch returns page content and shares its pending request with navigation", async ({
  page,
}) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-full-prefetch-"));
  let server: Server | undefined;

  try {
    await writeFixture(fixtureRoot);
    const { createBuilder } = await import("vite");
    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: path.join(fixtureRoot, "vite.config.ts"),
      logLevel: "silent",
    });
    await builder.buildApp();

    const { startProdServer } = await import(
      pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
    );
    const started = await startProdServer({
      host: "127.0.0.1",
      port: 0,
      outDir: path.join(fixtureRoot, "dist"),
      noCompression: true,
    });
    server = started.server;
    const baseUrl = `http://127.0.0.1:${started.port}`;

    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      const state: FullPrefetchState = {
        release: null,
        requestCount: 0,
        responseText: "",
        routerPrefetchHeader: null,
        routerStateHeader: null,
      };
      (window as FullPrefetchWindow).__VINEXT_FULL_PREFETCH_TEST__ = state;

      window.fetch = async (input, init) => {
        const rawUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(rawUrl, window.location.href);
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        if (init?.headers) {
          new Headers(init.headers).forEach((value, key) => headers.set(key, value));
        }

        if (url.pathname === "/target" && url.searchParams.has("_rsc")) {
          const routerPrefetchHeader = headers.get("next-router-prefetch");
          // Main may warm a loading shell alongside an explicit full prefetch.
          // This fixture gates and counts only the full response whose pending
          // request must be shared with the click navigation.
          if (routerPrefetchHeader !== null) {
            return originalFetch(input, init);
          }
          state.requestCount += 1;
          state.routerPrefetchHeader = routerPrefetchHeader;
          state.routerStateHeader = headers.get("next-router-state-tree");
          const response = await originalFetch(input, init);
          state.responseText = await response.clone().text();
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
          return response;
        }

        return originalFetch(input, init);
      };
    });

    await page.goto(baseUrl);
    await waitForAppRouterHydration(page);
    await expect
      .poll(() => page.evaluate(() => (window as FullPrefetchWindow).__VINEXT_FULL_PREFETCH_TEST__))
      .toMatchObject({
        requestCount: 1,
        routerPrefetchHeader: null,
      });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as FullPrefetchWindow).__VINEXT_FULL_PREFETCH_TEST__?.responseText,
        ),
      )
      .toContain("Full prefetch page content");

    await page.locator("#full-prefetch-link").evaluate((element: HTMLElement) => element.click());
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(
        () => (window as FullPrefetchWindow).__VINEXT_FULL_PREFETCH_TEST__?.requestCount,
      ),
    ).toBe(1);

    await page.evaluate(() => {
      const state = (window as FullPrefetchWindow).__VINEXT_FULL_PREFETCH_TEST__;
      if (!state?.release) throw new Error("Full prefetch response was not pending");
      state.release();
    });

    await expect(page.locator("#target-content")).toHaveText("Full prefetch page content");
    expect(
      await page.evaluate(
        () => (window as FullPrefetchWindow).__VINEXT_FULL_PREFETCH_TEST__?.requestCount,
      ),
    ).toBe(1);
    expect(
      await page.evaluate(
        () => (window as FullPrefetchWindow).__VINEXT_FULL_PREFETCH_TEST__?.routerStateHeader,
      ),
    ).toBeTruthy();
  } finally {
    await page.close();
    if (server) await closeServer(server);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("only a settled prepared prefetch commits in the initiating click task", async ({ page }) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-settled-prefetch-"));
  let server: Server | undefined;

  try {
    await writeFixture(fixtureRoot);
    const { createBuilder } = await import("vite");
    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: path.join(fixtureRoot, "vite.config.ts"),
      logLevel: "silent",
    });
    await builder.buildApp();

    const { startProdServer } = await import(
      pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
    );
    const started = await startProdServer({
      host: "127.0.0.1",
      port: 0,
      outDir: path.join(fixtureRoot, "dist"),
      noCompression: true,
    });
    server = started.server;
    const baseUrl = `http://127.0.0.1:${started.port}`;

    const settledFullResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/settled-target" &&
        url.searchParams.has("_rsc") &&
        response.request().headers()["next-router-prefetch"] === undefined
      );
    });
    await page.goto(baseUrl);
    await waitForAppRouterHydration(page);
    await (await settledFullResponse).finished();
    // Preparation is CPU-local once the full response body settles.
    await page.waitForTimeout(50);

    expect(
      await page.evaluate(() => {
        document.querySelector<HTMLElement>("#settled-prefetch-link")?.click();
        return document.querySelector("#settled-target-content")?.textContent ?? null;
      }),
    ).toBe("Settled prefetch page content");

    await page.goto(baseUrl);
    await waitForAppRouterHydration(page);
    expect(
      await page.evaluate(() => {
        document.querySelector<HTMLElement>("#no-prefetch-link")?.click();
        return document.querySelector("#no-prefetch-target-content")?.textContent ?? null;
      }),
    ).toBeNull();
    await expect(page.locator("#no-prefetch-target-content")).toHaveText(
      "No prefetch page content",
    );
  } finally {
    await page.close();
    if (server) await closeServer(server);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
