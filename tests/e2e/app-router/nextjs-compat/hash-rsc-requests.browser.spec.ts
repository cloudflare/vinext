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

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const sourceNodeModules = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const targetNodeModules = path.join(fixtureRoot, "node_modules");

  await fs.mkdir(targetNodeModules, { recursive: true });

  for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
    if (entry.name === ".vite-temp") continue;

    await fs.symlink(
      path.join(sourceNodeModules, entry.name),
      path.join(targetNodeModules, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
}

async function writeHashRscFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  const routeDir = path.join(appDir, "nextjs-compat", "hash-rsc-requests");
  await fs.mkdir(routeDir, { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);

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
    <div style={{ fontFamily: "sans-serif", fontSize: "16px" }}>
      <p>Hash Page</p>
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
        To 500 (hash only)
      </Link>
      <Link href="/nextjs-compat/hash-rsc-requests#top" id="link-to-top">
        To Top
      </Link>
      <Link href="/nextjs-compat/hash-rsc-requests#non-existent" id="link-to-non-existent">
        To non-existent
      </Link>
      <div>
        <Link href="?with-query-param#hash-160" id="link-to-query-param">
          To 160 (with query param)
        </Link>
      </div>
      <div>
        {items.map((item) => (
          <div key={item.id}>
            <div id={\`hash-\${item.id}\`}>{item.id}</div>
          </div>
        ))}
      </div>
    </div>
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
  await fs.writeFile(
    path.join(fixtureRoot, "middleware.ts"),
    `import { NextResponse, type NextRequest } from "next/server";

const NEXT_RSC_UNION_QUERY = "_rsc";

export function middleware(request: NextRequest) {
  // Mirrors Next.js' navigation fixture: middleware should never observe the
  // internal RSC cache-busting query in request.nextUrl.
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/navigation/middleware.js
  if (request.nextUrl.searchParams.has(NEXT_RSC_UNION_QUERY)) {
    return new Response("RSC query leaked to middleware", { status: 599 });
  }

  return NextResponse.next();
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
      // The fixture middleware returns HTTP 599 if the internal `_rsc`
      // cache-busting query ever leaks into request.nextUrl. Track every
      // response so a regression in the `_rsc`-hiding logic fails with a clear
      // status assertion instead of an indirect scroll-offset mismatch (a 599
      // on the RSC fetch would hard-navigate rather than soft-navigate).
      const middlewareLeakResponses: string[] = [];
      page.on("response", (response) => {
        if (response.status() === 599) {
          middlewareLeakResponses.push(response.url());
        }
      });
      const checkLink = async (id: number | string, expectedScroll: number) => {
        await page.locator(`#link-to-${id.toString()}`).click();
        await expect.poll(() => page.evaluate(() => window.pageYOffset)).toBe(expectedScroll);
      };

      await page.goto(`${app.baseUrl}/nextjs-compat/hash-rsc-requests`);
      await waitForAppRouterHydration(page);
      await expect(page.locator("p")).toHaveText("Hash Page");
      // Wait for all initial network activity (including the query-param link's
      // viewport prefetch) to settle *before* clearing the tracked RSC requests.
      // Otherwise the prefetch can land after the clear on slower runtimes
      // (e.g. WebKit) and be misattributed to the hash-only navigations below.
      // Mirrors upstream's `waitForIdleNetwork()` in the ported Next.js test.
      await page.waitForLoadState("networkidle");
      rscRequestUrls.clear();

      await checkLink(6, 128);
      await checkLink(50, 744);
      await checkLink(160, 2284);
      await checkLink(300, 4244);
      await checkLink(500, 7044);
      await checkLink("top", 0);
      await checkLink("non-existent", 0);

      const hasQueryParamRscRequestBeforeQueryChange = Array.from(rscRequestUrls).some((url) =>
        url.includes("with-query-param"),
      );
      expect(hasQueryParamRscRequestBeforeQueryChange).toBe(false);

      await checkLink("query-param", 2284);
      await expect(page).toHaveURL(
        `${app.baseUrl}/nextjs-compat/hash-rsc-requests?with-query-param#hash-160`,
      );

      await expect
        .poll(() => Array.from(rscRequestUrls).some((url) => url.includes("with-query-param")))
        .toBe(true);

      // No request (RSC fetch included) should have leaked `_rsc` to the
      // fixture middleware, which would have responded with HTTP 599.
      expect(middlewareLeakResponses).toEqual([]);
    } finally {
      // Close the page before the server so late idle-scheduled Link
      // prefetches can't hit a closed port.
      await page.close();
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });
});
