import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page, type Response } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: Server;
};

type SegmentPrefetchResponse = {
  body: string;
  segment: string;
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
  await fs.mkdir(path.join(appDir, "(main)", "root-params"), { recursive: true });
  await fs.mkdir(path.join(appDir, "[rootParam]"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "components"), { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "next.config.ts"),
    `const nextConfig = {
  cacheComponents: true,
  experimental: {
    optimisticRouting: true,
    varyParams: true,
  },
};

export default nextConfig;
`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "components", "link-accordion.tsx"),
    `"use client";

import Link from "next/link";
import { useState } from "react";

export function LinkAccordion({ href, children }: { href: string; children: React.ReactNode }) {
  const [isVisible, setIsVisible] = useState(false);
  return <>
    <input
      type="checkbox"
      checked={isVisible}
      onChange={() => setIsVisible(!isVisible)}
      data-link-accordion={href}
    />
    {isVisible ? <Link href={href}>{children}</Link> : <>{children} (link is hidden)</>}
  </>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "(main)", "layout.tsx"),
    `import type { ReactNode } from "react";

export default function MainLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "(main)", "root-params", "page.tsx"),
    `import { LinkAccordion } from "../../../components/link-accordion";

export default function RootParamsIndexPage() {
  return <main id="root-params-index">
    <LinkAccordion href="/aaa">Root Param: aaa</LinkAccordion>
    <LinkAccordion href="/bbb">Root Param: bbb</LinkAccordion>
  </main>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "[rootParam]", "loading.tsx"),
    `export default function Loading() {
  return <div data-root-param-loading="true">Loading root param...</div>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "[rootParam]", "layout.tsx"),
    `import { rootParam } from "next/root-params";
import type { ReactNode } from "react";

export function generateStaticParams() {
  return [{ rootParam: "aaa" }, { rootParam: "bbb" }];
}

export default async function RootParamsLayout({ children }: { children: ReactNode }) {
  const param = await rootParam();
  return <html><body>
    <div data-root-param={param}>{\`Root param layout - param: \${param}\`}</div>
    {children}
  </body></html>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "[rootParam]", "page.tsx"),
    `import { rootParam } from "next/root-params";

export default async function RootParamsPage() {
  const param = await rootParam();
  return <div id="root-params-page">{\`Root param page content - param: \${param}\`}</div>;
}
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
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-root-params-prefetch-"));
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

async function revealAndReadSegmentPrefetches(
  page: Page,
  href: string,
  expectedContent: string,
): Promise<SegmentPrefetchResponse[]> {
  const responseBodies: Array<Promise<SegmentPrefetchResponse>> = [];
  const onResponse = (response: Response) => {
    const segment = response.request().headers()["next-router-segment-prefetch"];
    if (segment === undefined) return;
    responseBodies.push(response.text().then((body) => ({ body, segment })));
  };
  page.on("response", onResponse);

  try {
    await page.locator(`input[data-link-accordion="${href}"]`).click();
    await expect
      .poll(async () => {
        const settled = await Promise.all(responseBodies);
        return settled.some(({ body }) => body.includes(expectedContent));
      })
      .toBe(true);
    return Promise.all(responseBodies);
  } finally {
    page.off("response", onResponse);
  }
}

test.setTimeout(90_000);

// Ported from Next.js:
// test/e2e/app-dir/segment-cache/vary-params/root-params-segment-prefetch.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/vary-params/root-params-segment-prefetch.test.ts
test("root-param Link prefetches use concrete segment request keys", async ({ page }) => {
  const app = await buildAndServeFixture();

  try {
    await page.goto(`${app.baseUrl}/root-params`);
    await waitForAppRouterHydration(page);

    const prefetchRoutes = await page.evaluate(() => window.__VINEXT_LINK_PREFETCH_ROUTES__ ?? []);
    expect(prefetchRoutes).toContainEqual(
      expect.objectContaining({
        patternParts: [":rootParam"],
        hasRootParams: true,
      }),
    );

    const aaaResponses = await revealAndReadSegmentPrefetches(
      page,
      "/aaa",
      "Root param page content - param: aaa",
    );
    expect(aaaResponses.map(({ segment }) => segment)).toEqual(
      expect.arrayContaining(["/_tree", "/__PAGE__"]),
    );
    expect(aaaResponses.every(({ body }) => !body.includes("%5BrootParam%5D"))).toBe(true);

    const bbbResponses = await revealAndReadSegmentPrefetches(
      page,
      "/bbb",
      "Root param page content - param: bbb",
    );
    expect(bbbResponses.map(({ segment }) => segment)).toEqual(
      expect.arrayContaining(["/_tree", "/__PAGE__"]),
    );
    expect(bbbResponses.every(({ body }) => !body.includes("%5BrootParam%5D"))).toBe(true);
  } finally {
    await closeServer(app.server);
    await fs.rm(app.fixtureRoot, { recursive: true, force: true });
  }
});
