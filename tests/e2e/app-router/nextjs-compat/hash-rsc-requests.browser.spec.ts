import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: Server;
};

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function writeHashRscFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  const routeDir = path.join(appDir, "nextjs-compat", "hash-rsc-requests");
  await fs.mkdir(routeDir, { recursive: true });
  await fs.symlink(
    path.resolve(process.cwd(), "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`,
  );
  await fs.writeFile(
    path.join(routeDir, "page.tsx"),
    `import Link from "next/link";

import "./global.css";

const items = Array.from({ length: 5000 }, (_, id) => ({ id }));

export default function HashRscRequestsPage() {
  return (
    <main style={{ fontFamily: "sans-serif", fontSize: "16px" }}>
      <h1>Hash RSC Requests</h1>
      <nav>
        <Link href="/nextjs-compat/hash-rsc-requests#hash-6" id="link-to-6">
          To 6
        </Link>
        <Link href="/nextjs-compat/hash-rsc-requests#hash-50" id="link-to-50">
          To 50
        </Link>
        <Link href="/nextjs-compat/hash-rsc-requests#hash-160" id="link-to-160">
          To 160
        </Link>
        <Link href="/nextjs-compat/hash-rsc-requests#hash-300" id="link-to-300">
          To 300
        </Link>
        <Link href="#hash-500" id="link-to-500">
          To 500
        </Link>
        <Link href="/nextjs-compat/hash-rsc-requests#top" id="link-to-top">
          To Top
        </Link>
        <Link href="/nextjs-compat/hash-rsc-requests#non-existent" id="link-to-non-existent">
          To non-existent
        </Link>
      </nav>
      <div>
        <Link href="?with-query-param#hash-160" id="link-to-query-param">
          To 160 with query param
        </Link>
      </div>
      <div>
        {items.map((item) => (
          <div id={\`hash-\${item.id}\`} key={item.id}>
            {item.id}
          </div>
        ))}
      </div>
    </main>
  );
}
`,
  );
  await fs.writeFile(
    path.join(routeDir, "global.css"),
    `* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  font-size: 14px;
  line-height: 1;
}
`,
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
}

async function buildAndServeHashRscFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-hash-rsc-"));
  await writeHashRscFixture(fixtureRoot);

  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();

  const { runPrerender } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/build/run-prerender.js")).href
  );
  await runPrerender({ root: fixtureRoot });

  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });

  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    fixtureRoot,
    server: started.server,
  };
}

test.setTimeout(90_000);

test.describe("Next.js compat: hash RSC requests in production", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/navigation/navigation.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/navigation/navigation.test.ts#L143-L198
  test("hash-only navigations do not request the query-param RSC payload", async ({ page }) => {
    const app = await buildAndServeHashRscFixture();

    try {
      const rscRequestUrls = new Set<string>();
      page.on("request", (request) => {
        const headers = request.headers();
        if (headers.rsc) {
          rscRequestUrls.add(request.url());
        }
      });

      await page.goto(`${app.baseUrl}/nextjs-compat/hash-rsc-requests`);
      await waitForAppRouterHydration(page);
      await expect(page.locator("h1")).toHaveText("Hash RSC Requests");
      rscRequestUrls.clear();

      await page.locator("#link-to-6").click();
      await expect(page.locator("#hash-6")).toBeInViewport();

      await page.locator("#link-to-50").click();
      await expect(page.locator("#hash-50")).toBeInViewport();

      await page.locator("#link-to-160").click();
      await expect(page.locator("#hash-160")).toBeInViewport();

      await page.locator("#link-to-300").click();
      await expect(page.locator("#hash-300")).toBeInViewport();

      await page.locator("#link-to-500").click();
      await expect(page.locator("#hash-500")).toBeInViewport();

      await page.locator("#link-to-top").click();
      await expect.poll(() => page.evaluate(() => window.pageYOffset)).toBe(0);

      await page.locator("#link-to-non-existent").click();
      await expect.poll(() => page.evaluate(() => window.pageYOffset)).toBe(0);

      const hasQueryParamRscRequestBeforeQueryChange = Array.from(rscRequestUrls).some((url) =>
        url.includes("with-query-param"),
      );
      expect(hasQueryParamRscRequestBeforeQueryChange).toBe(false);

      await page.locator("#link-to-query-param").click();
      await expect(page.locator("#hash-160")).toBeInViewport();
      await expect(page).toHaveURL(
        `${app.baseUrl}/nextjs-compat/hash-rsc-requests?with-query-param#hash-160`,
      );

      await expect
        .poll(() => Array.from(rscRequestUrls).some((url) => url.includes("with-query-param")))
        .toBe(true);
    } finally {
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });
});
