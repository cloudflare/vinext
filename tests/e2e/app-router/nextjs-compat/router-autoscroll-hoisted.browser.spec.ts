import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";
import {
  startChildViteDevServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../../production-server";

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
  const cssModuleDir = path.join(appDir, "css-module", "[num]");
  await fs.mkdir(hoistedDir, { recursive: true });
  await fs.mkdir(cssModuleDir, { recursive: true });
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
  await fs.writeFile(
    path.join(cssModuleDir, "styles.module.css"),
    `.square {
  /* Intentionally empty: React still hoists the route stylesheet resource. */
}
`,
  );
  await fs.writeFile(
    path.join(cssModuleDir, "page.tsx"),
    `import Link from "next/link";
import styles from "./styles.module.css";

export default async function CssModulePage({
  params,
}: {
  params: Promise<{ num: string }>;
}) {
  const { num } = await params;
  return (
    <div>
      {Array.from({ length: 100 }, (_, index) => (
        <div key={index} style={{ height: 100, width: 100, margin: 10 }}>
          <Link id="lower" href={\`/css-module/\${Number(num) - 1}\`} prefetch={false}>
            lower
          </Link>
          <div>{num}</div>
        </div>
      ))}
      <div className={styles.square} />
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

async function startHoistedScrollFixture(): Promise<{
  baseUrl: string;
  fixtureRoot: string;
  server: ChildProductionServer;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-hoisted-scroll-"));
  await writeHoistedScrollFixture(fixtureRoot);

  const server = await startChildViteDevServer(fixtureRoot);
  return { baseUrl: `http://127.0.0.1:${server.port}`, fixtureRoot, server };
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
    try {
      await stopChildProductionServer(app.server);
    } finally {
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  }
});

for (const clickMode of ["playwright", "javascript"] as const) {
  test(`scrolls to top for CSS Module navigation clicked via ${clickMode}`, async ({ page }) => {
    const app = await startHoistedScrollFixture();

    try {
      await page.goto(`${app.baseUrl}/css-module/1`);
      await waitForAppRouterHydration(page);
      await page.evaluate(() => window.scrollTo(0, 1000));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(1000);

      if (clickMode === "javascript") {
        await page.evaluate(() => document.getElementById("lower")?.click());
      } else {
        await page.locator("#lower").first().click();
      }

      await expect(page).toHaveURL(`${app.baseUrl}/css-module/0`);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      try {
        await stopChildProductionServer(app.server);
      } finally {
        await fs.rm(app.fixtureRoot, { recursive: true, force: true });
      }
    }
  });
}
