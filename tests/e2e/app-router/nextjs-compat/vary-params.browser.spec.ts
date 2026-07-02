import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../../production-server";

const ROOT = "/nextjs-compat/segment-cache-vary-params/search-params";

type RscRequest = {
  pathname: string;
  search: string;
};

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: ChildProductionServer;
};

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

async function writeVaryParamsFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  const routeRoot = path.join(appDir, "nextjs-compat", "segment-cache-vary-params");
  const searchParamsDir = path.join(routeRoot, "search-params");
  await fs.mkdir(path.join(searchParamsDir, "static-target"), { recursive: true });
  await fs.mkdir(path.join(searchParamsDir, "target-page"), { recursive: true });
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
    path.join(routeRoot, "link-accordion.tsx"),
    `"use client";

import Link from "next/link";
import { useState } from "react";

export function LinkAccordion({ href, children }: { href: string; children: React.ReactNode }) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <>
      <input
        type="checkbox"
        checked={isVisible}
        onChange={() => setIsVisible(!isVisible)}
        data-link-accordion={href}
      />
      {isVisible ? <Link href={href}>{children}</Link> : <>{children} (link is hidden)</>}
    </>
  );
}
`,
  );
  await fs.writeFile(
    path.join(searchParamsDir, "page.tsx"),
    `import { LinkAccordion } from "../link-accordion";

export default function SearchParamsIndexPage() {
  return (
    <div id="segment-cache-vary-search-params-index">
      <h1>Segment Cache Vary Params</h1>
      <ul>
        <li>
          <LinkAccordion href="${ROOT}/static-target?foo=1">Static target with foo=1</LinkAccordion>
        </li>
        <li>
          <LinkAccordion href="${ROOT}/static-target?foo=2">Static target with foo=2</LinkAccordion>
        </li>
        <li>
          <LinkAccordion href="${ROOT}/target-page?foo=1">Target with foo=1</LinkAccordion>
        </li>
        <li>
          <LinkAccordion href="${ROOT}/target-page?foo=2">Target with foo=2</LinkAccordion>
        </li>
      </ul>
    </div>
  );
}
`,
  );
  await fs.writeFile(
    path.join(searchParamsDir, "static-target", "page.tsx"),
    `export default function StaticTargetPage() {
  return (
    <div id="segment-cache-vary-static-target-page">
      <div data-static-target-content="true">Static target content - no searchParams access</div>
    </div>
  );
}
`,
  );
  await fs.writeFile(
    path.join(searchParamsDir, "target-page", "page.tsx"),
    `type SearchParams = { foo?: string };

export default async function SearchParamsTargetPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { foo } = await searchParams;

  return (
    <div id="segment-cache-vary-search-params-target-page">
      <div data-search-params-content="true">
        {\`Search params target - foo: \${foo ?? "undefined"}\`}
      </div>
    </div>
  );
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

async function buildAndServeVaryParamsFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-vary-params-"));
  await writeVaryParamsFixture(fixtureRoot);

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

  const started = await startChildProductionServer(fixtureRoot);

  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    fixtureRoot,
    server: started,
  };
}

function trackRscRequests(page: Page): RscRequest[] {
  const requests: RscRequest[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.searchParams.has("_rsc") || request.headers()["rsc"] !== "1") return;
    requests.push({ pathname: url.pathname, search: url.search });
  });
  return requests;
}

async function revealLink(page: Page, href: string): Promise<void> {
  await page.locator(`input[data-link-accordion="${href}"]`).click();
  const link = page.locator(`a[href="${href}"]`);
  await expect(link).toBeVisible();
  await link.hover();
}

function requestsFor(requests: readonly RscRequest[], pathname: string): RscRequest[] {
  return requests.filter((request) => request.pathname === pathname);
}

function requireStartedApp(app: ProductionApp | undefined): ProductionApp {
  if (!app) throw new Error("Vary params fixture was not started");
  return app;
}

test.describe("Next.js compat: segment cache vary params", () => {
  let app: ProductionApp | undefined;

  test.setTimeout(90_000);

  test.beforeAll(async () => {
    app = await buildAndServeVaryParamsFixture();
  });

  test.afterAll(async () => {
    if (!app) return;
    try {
      await stopChildProductionServer(app.server);
    } finally {
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });

  // Ported from Next.js: test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts
  test("reuses prefetched static page segment across search params when searchParams are not accessed", async ({
    page,
  }) => {
    const currentApp = requireStartedApp(app);
    const requests = trackRscRequests(page);
    const target = `${ROOT}/static-target`;

    await page.goto(`${currentApp.baseUrl}${ROOT}`);
    await waitForAppRouterHydration(page);
    await revealLink(page, `${target}?foo=1`);
    await expect.poll(() => requestsFor(requests, target).length).toBe(1);

    requests.length = 0;
    await revealLink(page, `${target}?foo=2`);
    await page.waitForTimeout(500);

    expect(requestsFor(requests, target)).toEqual([]);
  });

  // Ported from Next.js: test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/vary-params/vary-params.test.ts
  test("does not reuse prefetched page segment when searchParams are accessed", async ({
    page,
  }) => {
    const currentApp = requireStartedApp(app);
    const requests = trackRscRequests(page);
    const target = `${ROOT}/target-page`;

    await page.goto(`${currentApp.baseUrl}${ROOT}`);
    await waitForAppRouterHydration(page);
    await revealLink(page, `${target}?foo=1`);
    await expect.poll(() => requestsFor(requests, target).length).toBe(1);

    requests.length = 0;
    await revealLink(page, `${target}?foo=2`);
    await expect.poll(() => requestsFor(requests, target).length).toBe(1);
  });
});
