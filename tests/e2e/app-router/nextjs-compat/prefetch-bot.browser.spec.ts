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

const GOOGLEBOT_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 " +
  "(compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

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

async function writePrefetchBotFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  const targetDir = path.join(appDir, "target");
  const formTargetDir = path.join(appDir, "form-target");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.mkdir(formTargetDir, { recursive: true });
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
    path.join(appDir, "page.tsx"),
    `import Form from "next/form";
import Link from "next/link";

export default function Page() {
  return <>
    <Link href="/target" id="target-link">Target</Link>
    <Form action="/form-target" id="target-form">
      <input name="q" defaultValue="vinext" />
      <button type="submit">Submit form</button>
    </Form>
  </>;
}
`,
  );
  await fs.writeFile(
    path.join(targetDir, "page.tsx"),
    `export default function TargetPage() {
  return <p id="target-page">Target page</p>;
}
`,
  );
  await fs.writeFile(
    path.join(formTargetDir, "page.tsx"),
    `export default async function FormTargetPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <p id="form-target-page">Form target: {q}</p>;
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

async function buildAndServePrefetchBotFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-prefetch-bot-"));
  await writePrefetchBotFixture(fixtureRoot);

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

test.setTimeout(90_000);

test.describe("Next.js compat: bot prefetching in production", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/app-prefetch/prefetching.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-prefetch/prefetching.test.ts
  test("does not prefetch links or forms but still navigates for a bot user agent", async ({
    page,
  }) => {
    const app = await buildAndServePrefetchBotFixture();

    try {
      await page.addInitScript((userAgent) => {
        Object.defineProperty(window.navigator, "userAgent", {
          configurable: true,
          value: userAgent,
        });
      }, GOOGLEBOT_USER_AGENT);

      const targetRequests: string[] = [];
      const formTargetRequests: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/target" && request.headers().rsc === "1") {
          targetRequests.push(request.url());
        }
        if (url.pathname === "/form-target" && request.headers().rsc === "1") {
          formTargetRequests.push(request.url());
        }
      });

      await page.goto(app.baseUrl);
      await waitForAppRouterHydration(page);
      await page.locator("#target-link").hover();
      await page.waitForTimeout(1_000);

      expect(targetRequests).toEqual([]);
      expect(formTargetRequests).toEqual([]);

      await page.locator("#target-link").click();
      await expect(page.locator("#target-page")).toHaveText("Target page");
      expect(targetRequests).toHaveLength(1);

      await page.goBack();
      await expect(page.locator("#target-form")).toBeVisible();
      await page.waitForTimeout(1_000);
      expect(formTargetRequests).toEqual([]);

      await page.getByRole("button", { name: "Submit form" }).click();
      await expect(page.locator("#form-target-page")).toHaveText("Form target: vinext");
      await expect(page).toHaveURL(`${app.baseUrl}/form-target?q=vinext`);
      expect(formTargetRequests).toHaveLength(1);
    } finally {
      await page.close();
      await stopChildProductionServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });
});
