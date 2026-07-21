import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../../production-server";

type ProductionApp = {
  root: string;
  server: ChildProductionServer;
  url: string;
};

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const source = path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules");
  const target = path.join(fixtureRoot, "node_modules");
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name === ".vite" || entry.name === ".vite-temp") continue;
    await fs.symlink(
      path.join(source, entry.name),
      path.join(target, entry.name),
      entry.isDirectory() ? "junction" : "file",
    );
  }
}

async function buildFixture(): Promise<ProductionApp> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-interception-two-levels-"));
  const app = path.join(root, "app");
  await fs.mkdir(path.join(app, "foo", "bar", "(..)(..)hoge"), { recursive: true });
  await fs.mkdir(path.join(app, "hoge"), { recursive: true });
  await linkFixtureNodeModules(root);
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module","dependencies":{}}\n');
  await fs.writeFile(
    path.join(app, "layout.tsx"),
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body><div id="children">{children}</div></body></html>;
}\n`,
  );
  await fs.writeFile(
    path.join(app, "foo", "bar", "page.tsx"),
    `import Link from "next/link";
export default function Page() { return <div><p id="source">source</p><Link href="/hoge">test</Link></div>; }\n`,
  );
  await fs.writeFile(
    path.join(app, "foo", "bar", "(..)(..)hoge", "page.tsx"),
    `export default function Page() { return <div id="intercepted">intercepted</div>; }\n`,
  );
  await fs.writeFile(
    path.join(app, "hoge", "page.tsx"),
    `export default function Page() { return <div id="hoge">hoge</div>; }\n`,
  );
  const vinextSource = path.resolve(process.cwd(), "packages/vinext/src/index.ts");
  await fs.writeFile(
    path.join(root, "vite.config.ts"),
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(pathToFileURL(vinextSource).href)};
export default defineConfig({ plugins: [vinext({ appDir: import.meta.dirname })] });\n`,
  );
  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root,
    configFile: path.join(root, "vite.config.ts"),
    logLevel: "silent",
  });
  await builder.buildApp();
  const { runPrerender } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/build/run-prerender.js")).href
  );
  await runPrerender({ root });
  const server = await startChildProductionServer(root);
  return { root, server, url: `http://127.0.0.1:${server.port}` };
}

test.setTimeout(90_000);

// Ported from Next.js: test/e2e/app-dir/interception-segments-two-levels-above/interception-segments-two-levels-above.test.ts
test("restores a two-level interception on forward navigation", async ({ page }) => {
  const fixture = await buildFixture();
  try {
    await page.goto(`${fixture.url}/foo/bar`);
    await waitForAppRouterHydration(page);
    await page.locator('a[href="/hoge"]').click();
    await expect(page.locator("#intercepted")).toHaveText("intercepted");
    await page.goBack();
    await expect(page.locator("#source")).toHaveText("source");
    await page.goForward();
    await expect(page.locator("#intercepted")).toHaveText("intercepted");
  } finally {
    await page.close();
    await stopChildProductionServer(fixture.server);
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
