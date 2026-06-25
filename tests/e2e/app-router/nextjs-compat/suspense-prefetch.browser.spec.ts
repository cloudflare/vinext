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
  const targetNodeModules = path.join(fixtureRoot, "node_modules");
  await fs.mkdir(targetNodeModules, { recursive: true });

  for (const sourceNodeModules of [
    path.resolve(process.cwd(), "node_modules"),
    path.resolve(process.cwd(), "packages/vinext/node_modules"),
    path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules"),
  ]) {
    for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
      if (entry.name === ".vite" || entry.name === ".vite-temp") continue;
      const target = path.join(targetNodeModules, entry.name);
      try {
        await fs.symlink(
          path.join(sourceNodeModules, entry.name),
          target,
          entry.isDirectory() ? "junction" : "file",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
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
    `import { Suspense } from "react";

export const revalidate = 30;

async function DynamicContent({ param }: { param: string }) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  return <div id={\`dynamic-page-content-\${param}\`}>{\`Dynamic page \${param}\`}</div>;
}

export default async function Page({ params }: { params: Promise<{ param: string }> }) {
  const { param } = await params;
  return <Suspense fallback={<div id={\`dynamic-page-loading-\${param}\`}>{\`Loading \${param}...\`}</div>}>
    <DynamicContent param={param} />
  </Suspense>;
}
`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "middleware.ts"),
    `import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  if (request.headers.get("x-vinext-rsc-render-mode")?.startsWith("prefetch-")) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "s-maxage=30");
    response.headers.set("CDN-Cache-Control", "s-maxage=30");
    response.headers.set("Cloudflare-CDN-Cache-Control", "s-maxage=30");
    response.headers.set("Cache-Tag", "partial-shell");
    response.headers.set("X-Vinext-Rsc-Partial-Shell", "0");
    return response;
  }
  const destination = request.nextUrl.searchParams.get("mismatch-rewrite");
  return destination ? NextResponse.rewrite(new URL(destination, request.url)) : NextResponse.next();
}

export const config = { matcher: "/mismatching-prefetch/:path*" };
`,
  );

  const vinextSource = path.resolve(process.cwd(), "packages/vinext/dist/index.js");
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
test("prefetches a fallback from a user Suspense boundary", async ({ page }) => {
  const app = await buildAndServeFixture();

  try {
    await page.goto(`${app.baseUrl}/mismatching-prefetch`);
    await waitForAppRouterHydration(page);

    const prefetchResponse = page.waitForResponse(async (response) => {
      const request = response.request();
      return (
        request.headers()["x-vinext-rsc-render-mode"]?.startsWith("prefetch-") === true &&
        response.url().includes("/mismatching-prefetch/dynamic-page/a?") &&
        response.headers()["x-vinext-rsc-partial-shell"] === "1" &&
        (await response.text()).includes("Loading a...")
      );
    });
    await page.click("#reveal-link");
    const response = await prefetchResponse;
    expect(response.ok()).toBe(true);
    expect(response.headers()["cache-control"]).toBe("no-store, must-revalidate");
    expect(response.headers()["cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cloudflare-cdn-cache-control"]).toBeUndefined();
    expect(response.headers()["cache-tag"]).toBeUndefined();
    expect(response.headers()["x-vinext-cache"]).toBeUndefined();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(
            (
              window as Window & {
                __VINEXT_RSC_PREFETCH_CACHE__?: Map<string, { cacheForNavigation?: boolean }>;
              }
            ).__VINEXT_RSC_PREFETCH_CACHE__?.values() ?? [],
          ).some((entry) => entry.cacheForNavigation === false),
        ),
      )
      .toBe(true);
  } finally {
    await closeServer(app.server);
    await fs.rm(app.fixtureRoot, { recursive: true, force: true });
  }
});
