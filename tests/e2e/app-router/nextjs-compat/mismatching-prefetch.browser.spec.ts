import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Route } from "@playwright/test";
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
  const sourceDir = path.join(appDir, "mismatching-prefetch");
  const dynamicDir = path.join(sourceDir, "dynamic-page", "[param]");
  await fs.mkdir(dynamicDir, { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  await fs.writeFile(
    path.join(sourceDir, "page.tsx"),
    `"use client";

import Link from "next/link";
import { useState } from "react";

const href = "/mismatching-prefetch/dynamic-page/a?mismatch-rewrite=./b";

export default function Page() {
  const [visible, setVisible] = useState(false);
  return <main>
    <button id="reveal-link" onClick={() => setVisible(true)}>Reveal link</button>
    {visible ? <Link id="mismatch-link" href={href}>Navigate</Link> : null}
  </main>;
}
`,
  );
  await fs.writeFile(
    path.join(dynamicDir, "page.tsx"),
    `import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";

export function generateStaticParams() {
  return [{ param: "a" }, { param: "b" }];
}

async function DynamicContent({ children }: { children: ReactNode }) {
  await connection();
  return children;
}

export default async function Page({ params }: { params: Promise<{ param: string }> }) {
  const { param } = await params;
  return (
    <Suspense fallback={<div id={\`dynamic-page-loading-\${param}\`}>{\`Loading \${param}...\`}</div>}>
      <DynamicContent>
        <div id={\`dynamic-page-content-\${param}\`}>{\`Dynamic page \${param}\`}</div>
      </DynamicContent>
    </Suspense>
  );
}
`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "middleware.ts"),
    `import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const destination = request.nextUrl.searchParams.get("mismatch-rewrite");
  return destination ? NextResponse.rewrite(new URL(destination, request.url)) : NextResponse.next();
}

export const config = {
  matcher: [
    {
      source: "/mismatching-prefetch/:path*",
      missing: [{ type: "header", key: "Next-Router-Prefetch" }],
    },
  ],
};
`,
  );

  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  await fs.writeFile(
    path.join(fixtureRoot, "vite.config.ts"),
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};

export default defineConfig({ plugins: [vinext({ appDir: import.meta.dirname })] });
`,
  );
}

async function buildAndServeFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-mismatch-prefetch-"));
  await writeFixture(fixtureRoot);

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

// Ported from Next.js:
// test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
test("recovers when navigation middleware rewrites away from the prefetched route", async ({
  page,
}) => {
  const app = await buildAndServeFixture();

  try {
    await page.goto(`${app.baseUrl}/mismatching-prefetch`);
    await waitForAppRouterHydration(page);

    const prefetchResponse = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.headers().rsc === "1" &&
        response.url().includes("/mismatching-prefetch/dynamic-page/a")
      );
    });
    await page.click("#reveal-link");
    await page.hover("#mismatch-link");
    const prefetchedShell = await prefetchResponse;
    expect(prefetchedShell.ok()).toBe(true);
    // Ported from Next.js:
    // test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
    expect(await prefetchedShell.text()).toContain("Loading a...");

    await page.evaluate(() => {
      (window as Window & { __MISMATCH_PREFETCH_MARKER__?: boolean }).__MISMATCH_PREFETCH_MARKER__ =
        true;
    });
    const documentRequests: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document") {
        documentRequests.push(request.url());
      }
    });

    let dynamicRequestReleasedValue = false;
    let releaseDynamicRequest!: () => void;
    const dynamicRequestReleased = new Promise<void>((resolve) => {
      releaseDynamicRequest = () => {
        if (dynamicRequestReleasedValue) return;
        dynamicRequestReleasedValue = true;
        resolve();
      };
    });
    const holdDynamicRequest = async (route: Route) => {
      const request = route.request();
      if (
        request.headers().rsc === "1" &&
        request.url().includes("/mismatching-prefetch/dynamic-page/a")
      ) {
        await dynamicRequestReleased;
      }
      await route.continue();
    };
    await page.route("**/mismatching-prefetch/dynamic-page/a**", holdDynamicRequest);

    try {
      await page.click("#mismatch-link");
      // Ported from Next.js:
      // test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
      // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
      await expect(page.locator("#dynamic-page-loading-a")).toHaveText("Loading a...");
      releaseDynamicRequest();
      await expect(page.locator("#dynamic-page-content-b")).toHaveText("Dynamic page b");
    } finally {
      releaseDynamicRequest();
    }
    expect(new URL(page.url()).pathname).toBe("/mismatching-prefetch/dynamic-page/a");
    expect(new URL(page.url()).search).toBe("?mismatch-rewrite=./b");
    expect(documentRequests).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __MISMATCH_PREFETCH_MARKER__?: boolean })
            .__MISMATCH_PREFETCH_MARKER__,
      ),
    ).toBe(true);
  } finally {
    await closeServer(app.server);
    await fs.rm(app.fixtureRoot, { recursive: true, force: true });
  }
});
