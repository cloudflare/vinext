import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../../fixtures";
import {
  startChildProductionServer,
  stopChildProductionServer,
  type ChildProductionServer,
} from "../../production-server";

type ProductionApp = {
  baseUrl: string;
  fixtureRoot: string;
  server: ChildProductionServer;
};

async function linkFixtureNodeModules(fixtureRoot: string): Promise<void> {
  const targetNodeModules = path.join(fixtureRoot, "node_modules");
  await fs.mkdir(targetNodeModules, { recursive: true });

  for (const sourceNodeModules of [
    path.resolve(process.cwd(), "node_modules"),
    path.resolve(process.cwd(), "node_modules/.pnpm/node_modules"),
  ]) {
    for (const entry of await fs.readdir(sourceNodeModules, { withFileTypes: true })) {
      if (entry.name === ".vite" || entry.name === ".vite-temp" || entry.name === "vinext")
        continue;
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

  await fs.symlink(
    path.resolve(process.cwd(), "packages/vinext"),
    path.join(targetNodeModules, "vinext"),
    "junction",
  );
}

async function writeFixture(fixtureRoot: string): Promise<void> {
  const sourceRoot = path.resolve(
    process.cwd(),
    "tests/fixtures/app-basic/app/nextjs-compat/dynamic-css",
  );
  const appDir = path.join(fixtureRoot, "app");
  await fs.cp(sourceRoot, appDir, { recursive: true });
  await linkFixtureNodeModules(fixtureRoot);
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  const externalPackageDir = path.join(fixtureRoot, "node_modules", "dynamic-css-package");
  await fs.mkdir(externalPackageDir, { recursive: true });
  await fs.writeFile(
    path.join(externalPackageDir, "package.json"),
    `${JSON.stringify({ name: "dynamic-css-package", type: "module", exports: "./index.jsx" })}\n`,
  );
  await fs.writeFile(
    path.join(externalPackageDir, "index.jsx"),
    `"use client";
import "./styles.css";

export default function ExternalPackageComponent() {
  return <p id="dynamic-css-external-package" className="dynamic-css-external-package">External package</p>;
}
`,
  );
  await fs.writeFile(
    path.join(externalPackageDir, "styles.css"),
    `.dynamic-css-external-package { color: rgb(0, 0, 255); }\n`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import type { ReactNode } from "react";
import "./layout.css";
import ExternalPackageComponent from "dynamic-css-package";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <ExternalPackageComponent />
        {children}
      </body>
    </html>
  );
}
`,
  );
  const sharedDir = path.join(fixtureRoot, "src", "components");
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(
    path.join(sharedDir, "shared-dynamic-component.tsx"),
    `import "../../app/page/global.css";
import "../../app/page/query.css?cache=shared";
import base from "../../app/page/base.module.css";
import styles from "../../app/page/component.module.css";

export default function SharedDynamicComponent() {
  return (
    <p
      id="dynamic-css-shared-component"
      className={\`dynamic-css-global dynamic-css-query \${base.class} \${styles.class}\`}
    >
      Hello Shared Component
    </p>
  );
}
`,
  );
  await fs.writeFile(
    path.join(sharedDir, "cross-route-component.tsx"),
    `"use client";

import "./cross-route.css";

export default function CrossRouteComponent() {
  return <p id="dynamic-css-cross-route" className="dynamic-css-cross-route">Cross route</p>;
}
`,
  );
  await fs.writeFile(
    path.join(sharedDir, "cross-route.css"),
    `.dynamic-css-cross-route { color: rgb(128, 0, 128); }\n`,
  );
  await fs.writeFile(
    path.join(sharedDir, "hybrid-shared-component.tsx"),
    `"use client";

import "./hybrid-shared.css";

export default function HybridSharedComponent() {
  return <p id="dynamic-css-hybrid-shared" className="dynamic-css-hybrid-shared">Hybrid shared</p>;
}
`,
  );
  await fs.writeFile(
    path.join(sharedDir, "hybrid-shared.css"),
    `.dynamic-css-hybrid-shared { color: rgb(0, 128, 128); }\n`,
  );
  const marketingDir = path.join(appDir, "marketing");
  await fs.mkdir(marketingDir, { recursive: true });
  await fs.writeFile(
    path.join(marketingDir, "page.tsx"),
    `import CrossRouteComponent from "../../src/components/cross-route-component";

export default function MarketingPage() {
  return <CrossRouteComponent />;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "page", "shared-layout-styles.tsx"),
    `import "../../src/components/shared-dynamic-component";
import CrossRouteComponent from "../../src/components/cross-route-component";
import HybridSharedComponent from "../../src/components/hybrid-shared-component";

export default function SharedLayoutStyles() {
  return (
    <>
      <CrossRouteComponent />
      <HybridSharedComponent />
    </>
  );
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "page", "dynamic-layout-component.tsx"),
    `"use client";

import "./dynamic-layout.css";

export default function DynamicLayoutComponent() {
  return <p id="dynamic-css-layout-import" className="dynamic-css-layout-import">Dynamic layout import</p>;
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "page", "dynamic-layout.css"),
    `.dynamic-css-layout-import { color: rgb(255, 165, 0); }\n`,
  );
  await fs.writeFile(
    path.join(appDir, "page", "layout.tsx"),
    `import type { ReactNode } from "react";
import dynamic from "next/dynamic";
import SharedLayoutStyles from "./shared-layout-styles";
import server from "./server.module.css";
import Inner from "./inner";

const DynamicLayoutComponent = dynamic(() => import("./dynamic-layout-component"));

export default function DynamicCssPageLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SharedLayoutStyles />
      <DynamicLayoutComponent />
      <p id="dynamic-css-server" className={\`dynamic-css-global \${server.class}\`}>
        Hello Server
      </p>
      <Inner />
      {children}
    </>
  );
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "page", "inner.tsx"),
    `"use client";

import dynamic from "next/dynamic";
import { Suspense } from "react";

const Component = dynamic(() => import("./component"));
const SharedComponent = dynamic(() => import("../../src/components/shared-dynamic-component"));

export default function Inner() {
  return (
    <Suspense>
      <Component />
      <SharedComponent />
    </Suspense>
  );
}
`,
  );
  const pagesDir = path.join(fixtureRoot, "pages");
  await fs.mkdir(pagesDir, { recursive: true });
  await fs.writeFile(
    path.join(sharedDir, "hybrid-pages-helper.tsx"),
    `import HybridSharedComponent from "./hybrid-shared-component";

export default function HybridPagesHelper() {
  return <HybridSharedComponent />;
}
`,
  );
  await fs.writeFile(
    path.join(pagesDir, "shared.tsx"),
    `import HybridPagesHelper from "../src/components/hybrid-pages-helper";

export default function SharedPage() {
  return <HybridPagesHelper />;
}
`,
  );

  const vinextSource = path.resolve(process.cwd(), "packages/vinext/dist/index.js");
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
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-dynamic-css-"));
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

  const started = await startChildProductionServer(fixtureRoot);

  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    fixtureRoot,
    server: started,
  };
}

test.setTimeout(90_000);

// Ported from Next.js: test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/next-dynamic-css/next-dynamic-css.test.ts
test("preserves CSS order across layouts, client components, and next/dynamic", async ({
  page,
}) => {
  const app = await buildAndServeFixture();

  try {
    await page.goto(`${app.baseUrl}/page`, { waitUntil: "load" });

    const server = page.locator("#dynamic-css-server");
    await expect(server).toHaveText("Hello Server");
    await expect(server).toHaveCSS("background-color", "rgb(0, 128, 0)");
    await expect(server).toHaveCSS("color", "rgb(0, 0, 0)");

    const inner = page.locator("#dynamic-css-inner2");
    await expect(inner).toHaveText("Hello Inner 2");
    await expect(inner).toHaveCSS("background-color", "rgb(0, 128, 0)");
    await expect(inner).toHaveCSS("color", "rgb(0, 0, 0)");

    const component = page.locator("#dynamic-css-component");
    await expect(component).toHaveText("Hello Component");
    await expect(component).toHaveCSS("background-color", "rgb(0, 128, 0)");
    await expect(component).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(component).toHaveCSS("border-top-color", "rgb(255, 0, 0)");

    const sharedComponent = page.locator("#dynamic-css-shared-component");
    await expect(sharedComponent).toHaveText("Hello Shared Component");
    await expect(sharedComponent).toHaveCSS("background-color", "rgb(0, 128, 0)");
    await expect(sharedComponent).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(sharedComponent).toHaveCSS("border-top-color", "rgb(255, 0, 0)");

    await expect(page.locator("#dynamic-css-global")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#dynamic-css-global")).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator("#dynamic-css-external-package")).toHaveCSS(
      "color",
      "rgb(0, 0, 255)",
    );
    await expect(page.locator("#dynamic-css-cross-route")).toHaveCSS("color", "rgb(128, 0, 128)");
    await expect(page.locator("#dynamic-css-layout-import")).toHaveCSS("color", "rgb(255, 165, 0)");
    await expect(page.locator("#dynamic-css-hybrid-shared")).toHaveCSS("color", "rgb(0, 128, 128)");

    await page.goto(`${app.baseUrl}/marketing`, { waitUntil: "load" });
    await expect(page.locator("#dynamic-css-cross-route")).toHaveText("Cross route");
    await expect(page.locator("#dynamic-css-cross-route")).toHaveCSS("color", "rgb(128, 0, 128)");
    await expect(page.locator("#dynamic-css-external-package")).toHaveCSS(
      "color",
      "rgb(0, 0, 255)",
    );

    await page.goto(`${app.baseUrl}/shared`, { waitUntil: "load" });
    await expect(page.locator("#dynamic-css-hybrid-shared")).toHaveText("Hybrid shared");
    await expect(page.locator("#dynamic-css-hybrid-shared")).toHaveCSS("color", "rgb(0, 128, 128)");
  } finally {
    await stopChildProductionServer(app.server);
    await fs.rm(app.fixtureRoot, { recursive: true, force: true });
  }
});
