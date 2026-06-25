import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../../fixtures";
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
  await fs.mkdir(path.join(appDir, "second"), { recursive: true });
  await fs.mkdir(path.join(appDir, "dynamic"), { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({ name: "metadata-static-navigation", private: true, type: "module" }),
  );
  await fs.writeFile(path.join(appDir, "favicon.ico"), Buffer.from([0, 0, 1, 0, 0, 0]));
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "page.tsx"),
    `import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Static Metadata One",
  description: "static metadata one description",
};

export default function Page() {
  return <main><h1>Static One</h1><Link id="to-second" href="/second">Second</Link></main>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "second", "page.tsx"),
    `import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Static Metadata Two",
  description: "static metadata two description",
};

export default function Page() {
  return <main><h1>Static Two</h1><Link id="to-first" href="/">First</Link></main>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "dynamic", "page.tsx"),
    `import Link from "next/link";
import { headers } from "next/headers";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dynamic Body Metadata",
  description: "dynamic body metadata description",
};

export default async function Page() {
  await headers();
  return <main><h1>Dynamic Body</h1><Link id="dynamic-to-second" href="/second">Second</Link></main>;
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

async function buildAndServeFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-metadata-static-nav-"));
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

test.describe("static metadata production navigation", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/ppr-metadata-streaming/ppr-metadata-streaming.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/ppr-metadata-streaming/ppr-metadata-streaming.test.ts
  test("hydrates body metadata without moving it into head until navigation", async ({
    page,
    consoleErrors,
  }) => {
    const app = await buildAndServeFixture();

    try {
      const response = await fetch(`${app.baseUrl}/dynamic`);
      const html = await response.text();
      const headHtml = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
      const bodyHtml = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? "";
      expect(headHtml).not.toContain("Dynamic Body Metadata");
      expect(bodyHtml).toContain("<title>Dynamic Body Metadata</title>");
      expect(bodyHtml).toContain(
        '<meta name="description" content="dynamic body metadata description">',
      );

      await page.goto(`${app.baseUrl}/dynamic`, { waitUntil: "load" });
      await waitForAppRouterHydration(page);
      await expect(page).toHaveTitle("Dynamic Body Metadata");
      await expect(page.locator("head > title")).toHaveCount(0);
      await expect(page.locator('head > meta[name="description"]')).toHaveCount(0);
      await expect(page.locator("body title")).toHaveCount(1);
      await expect(page.locator('body meta[name="description"]')).toHaveAttribute(
        "content",
        "dynamic body metadata description",
      );
      expect(consoleErrors).toEqual([]);

      await page.locator("#dynamic-to-second").click();
      await expect(page.getByRole("heading", { name: "Static Two" })).toBeVisible();
      await expect(page).toHaveTitle("Static Metadata Two");
      await expect(page.locator("head > title")).toHaveCount(1);
      await expect(page.locator('head > meta[name="description"]')).toHaveAttribute(
        "content",
        "static metadata two description",
      );
      await expect(page.locator("body title")).toHaveCount(0);
      await expect(page.locator('body meta[name="description"]')).toHaveCount(0);
      expect(consoleErrors).toEqual([]);
    } finally {
      await page.close();
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });

  // Ported from Next.js:
  // test/e2e/app-dir/metadata-navigation/metadata-navigation.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata-navigation/metadata-navigation.test.ts#L95-L108
  test("updates document metadata without duplicating the SSR head", async ({
    page,
    consoleErrors,
  }) => {
    const app = await buildAndServeFixture();

    try {
      await page.goto(app.baseUrl, { waitUntil: "load" });
      await waitForAppRouterHydration(page);
      await expect(page).toHaveTitle("Static Metadata One");
      await expect(page.locator("head > title")).toHaveCount(1);
      await expect(page.locator('head > meta[name="description"]')).toHaveAttribute(
        "content",
        "static metadata one description",
      );
      expect(consoleErrors).toEqual([]);

      await page.evaluate(() => {
        window.sessionStorage.setItem("metadata-navigation-document", "preserved");
      });
      await page.locator("#to-second").click();
      await expect(page.getByRole("heading", { name: "Static Two" })).toBeVisible();
      await expect(page).toHaveTitle("Static Metadata Two");
      await expect(page.locator("head > title")).toHaveCount(1);
      await expect(page.locator('head > meta[name="description"]')).toHaveCount(1);
      await expect(page.locator('head > meta[name="description"]')).toHaveAttribute(
        "content",
        "static metadata two description",
      );
      expect(
        await page.evaluate(() => window.sessionStorage.getItem("metadata-navigation-document")),
      ).toBe("preserved");

      await page.locator("#to-first").click();
      await expect(page.getByRole("heading", { name: "Static One" })).toBeVisible();
      await expect(page).toHaveTitle("Static Metadata One");
      await expect(page.locator("head > title")).toHaveCount(1);
      await expect(page.locator('head > meta[name="description"]')).toHaveCount(1);
      await expect(page.locator('head > meta[name="description"]')).toHaveAttribute(
        "content",
        "static metadata one description",
      );
      expect(consoleErrors).toEqual([]);
    } finally {
      await page.close();
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });
});
