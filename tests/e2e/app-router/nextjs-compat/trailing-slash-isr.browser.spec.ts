import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

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
  const revalidateRouteDir = path.join(appDir, "api", "revalidate");
  const langDir = path.join(appDir, "[lang]");
  const legacyDir = path.join(langDir, "legacy");
  await Promise.all([
    fs.mkdir(legacyDir, { recursive: true }),
    fs.mkdir(revalidateRouteDir, { recursive: true }),
  ]);
  await linkFixtureNodeModules(fixtureRoot);

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "next.config.mjs"),
    `export default {
  trailingSlash: true,
  rewrites: async () => [{
    source: "/:lang(en|es)/",
    destination: "/:lang/legacy/",
  }],
};
`,
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
    path.join(langDir, "layout.tsx"),
    `import type { ReactNode } from "react";

export function generateStaticParams() {
  return [{ lang: "en" }, { lang: "es" }];
}

export default function LangLayout({ children }: { children: ReactNode }) {
  return <main>{children}</main>;
}
`,
  );
  await fs.writeFile(
    path.join(legacyDir, "page.tsx"),
    `import { randomUUID } from "node:crypto";

export const revalidate = 900;

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  return <p id="generated-at">{lang}:{randomUUID()}</p>;
}
`,
  );
  await fs.writeFile(
    path.join(revalidateRouteDir, "route.ts"),
    `import { revalidatePath } from "next/cache";

export async function GET(request: Request) {
  const withSlash = new URL(request.url).searchParams.get("withSlash") !== "false";
  revalidatePath(withSlash ? "/en/legacy/" : "/en/legacy");
  return Response.json({ revalidated: true });
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
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-trailing-slash-isr-"));
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

test.describe("Next.js compat: trailing-slash ISR rewrites", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/trailingslash/trailingslash.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/trailingslash/trailingslash.test.ts
  test("revalidates a generated static-param page through a trailing-slash rewrite", async ({
    page,
  }) => {
    const app = await buildAndServeFixture();

    try {
      const response = await page.goto(`${app.baseUrl}/en/`);
      expect(response?.status()).toBe(200);
      const generatedAt = page.locator("#generated-at");
      await expect(generatedAt).toContainText("en:");
      let previousValue = await generatedAt.textContent();

      await page.reload();
      await expect(generatedAt).toHaveText(previousValue!);

      for (const withSlash of [true, false]) {
        const revalidateResponse = await page.request.get(
          `${app.baseUrl}/api/revalidate/?withSlash=${withSlash}`,
        );
        expect(revalidateResponse.status()).toBe(200);

        await page.reload();
        await expect.poll(() => generatedAt.textContent()).not.toBe(previousValue);
        previousValue = await generatedAt.textContent();
      }
    } finally {
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  });
});
