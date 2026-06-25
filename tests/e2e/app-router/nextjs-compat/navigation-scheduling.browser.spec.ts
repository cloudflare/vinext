import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "../../fixtures";
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

async function writeNavigationSchedulingFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  const blogDir = path.join(appDir, "blog", "[slug]");

  await fs.mkdir(blogDir, { recursive: true });
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
    `"use client";

import Link from "next/link";
import { useState } from "react";

function LinkAccordion({ href, prefetch }: { href: string; prefetch?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <input
        type="checkbox"
        data-link-accordion={href}
        checked={visible}
        onChange={() => setVisible((current) => !current)}
      />
      {visible ? <Link href={href} prefetch={prefetch}>{href}</Link> : null}
    </div>
  );
}

export default function HomePage() {
  return (
    <main>
      <LinkAccordion href="/blog/post-1" />
      <LinkAccordion href="/blog/post-2" prefetch={false} />
    </main>
  );
}
`,
  );
  await fs.writeFile(
    path.join(blogDir, "loading.tsx"),
    `"use client";

import { useParams } from "next/navigation";

export default function Loading() {
  const params = useParams<{ slug: string }>();
  return <p id="loading-message">Loading {params.slug}...</p>;
}
`,
  );
  await fs.writeFile(
    path.join(blogDir, "page.tsx"),
    `export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <h1 id="post-title">Blog Post: {slug}</h1>;
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

async function buildAndServeNavigationSchedulingFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-navigation-scheduling-"));
  await writeNavigationSchedulingFixture(fixtureRoot);

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

  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    fixtureRoot,
    server: started.server,
  };
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks -- Playwright fixture `use`, not a React hook */
const test = base.extend<{ navigationSchedulingApp: ProductionApp }>({
  navigationSchedulingApp: async ({ page }, use) => {
    const app = await buildAndServeNavigationSchedulingFixture();

    try {
      await use(app);
    } finally {
      await page.close();
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  },
});
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

test.setTimeout(90_000);

// Ported from Next.js: test/e2e/app-dir/optimistic-routing/optimistic-routing.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/optimistic-routing/optimistic-routing.test.ts
test("predicts a dynamic loading shell for an unprefetched sibling route", async ({
  page,
  navigationSchedulingApp,
}) => {
  let releaseNavigation!: () => void;
  const navigationBlocked = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  let post1Prefetched = false;

  await page.route("**/blog/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.searchParams.has("_rsc")) {
      await route.continue();
      return;
    }

    if (url.pathname === "/blog/post-1" || url.pathname === "/blog/post-1.rsc") {
      post1Prefetched = true;
      await route.continue();
      return;
    }

    if (url.pathname === "/blog/post-2" || url.pathname === "/blog/post-2.rsc") {
      await navigationBlocked;
    }
    await route.continue();
  });

  await page.addInitScript(() => {
    window.requestIdleCallback = () => 1;
  });
  await page.goto(navigationSchedulingApp.baseUrl);
  await waitForAppRouterHydration(page);
  await page.locator('input[data-link-accordion="/blog/post-1"]').click();
  await expect.poll(() => post1Prefetched).toBe(true);

  await page.locator('input[data-link-accordion="/blog/post-2"]').click();
  await page.locator('a[href="/blog/post-2"]').click();
  await expect(page.locator("#loading-message")).toHaveText("Loading post-2...");

  releaseNavigation();
  await expect(page.locator("#post-title")).toHaveText("Blog Post: post-2");
});

// Ported from Next.js: test/e2e/app-dir/app-prefetch/prefetching.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-prefetch/prefetching.test.ts
test("does not prefetch viewport links for bot user agents", async ({
  page,
  navigationSchedulingApp,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    });
  });

  let prefetchRequests = 0;
  await page.route("**/blog/post-1**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.searchParams.has("_rsc")) {
      prefetchRequests += 1;
    }
    await route.continue();
  });

  await page.goto(navigationSchedulingApp.baseUrl);
  await waitForAppRouterHydration(page);
  await page.locator('input[data-link-accordion="/blog/post-1"]').click();
  await page.locator('a[href="/blog/post-1"]').hover();
  await page.waitForTimeout(250);

  expect(prefetchRequests).toBe(0);
});
