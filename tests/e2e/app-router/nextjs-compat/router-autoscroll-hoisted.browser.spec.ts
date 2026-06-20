import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { waitForAppRouterHydration } from "../../helpers";

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

async function writeHoistedScrollFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  const hoistedDir = path.join(appDir, "hoisted");
  await fs.mkdir(hoistedDir, { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "page.tsx"),
    `import Link from "next/link";

export default function HomePage() {
  return (
    <>
      <Link href="/hoisted" id="to-hoisted" prefetch={false}>Hoisted page</Link>
      {Array.from({ length: 500 }, (_, index) => <div key={index}>{index}</div>)}
    </>
  );
}
`,
  );
  await fs.writeFile(
    path.join(hoistedDir, "page.tsx"),
    `export default function HoistedPage() {
  return (
    <>
      <style href="custom-stylesheet" precedence="alpha" />
      <div id="hoisted-page">Hoisted page</div>
      {Array.from({ length: 500 }, (_, index) => <div key={index}>{index}</div>)}
    </>
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

async function startHoistedScrollFixture(): Promise<{
  baseUrl: string;
  fixtureRoot: string;
  server: ViteDevServer;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-hoisted-scroll-"));
  await writeHoistedScrollFixture(fixtureRoot);

  const { createServer } = await import("vite");
  const server = await createServer({
    root: fixtureRoot,
    configFile: path.join(fixtureRoot, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();

  const baseUrl = server.resolvedUrls?.local[0];
  if (!baseUrl) {
    await server.close();
    throw new Error("Vite did not expose a local fixture URL");
  }

  return { baseUrl: baseUrl.replace(/\/$/, ""), fixtureRoot, server };
}

test.setTimeout(60_000);

test("does not scroll to top when React hoists the route's first DOM node", async ({ page }) => {
  const app = await startHoistedScrollFixture();

  try {
    await page.goto(app.baseUrl);
    await waitForAppRouterHydration(page);
    await expect(page.locator('head style[data-href="custom-stylesheet"]')).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await page.locator("#to-hoisted").evaluate((element: HTMLElement) => element.click());
    await expect(page.locator("#hoisted-page")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(0);
  } finally {
    await app.server.close();
    await fs.rm(app.fixtureRoot, { recursive: true, force: true });
  }
});
