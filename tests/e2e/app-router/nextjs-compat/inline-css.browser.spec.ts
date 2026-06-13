import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test as base, expect } from "../../fixtures";

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

async function writeInlineCssFixture(fixtureRoot: string): Promise<void> {
  const appDir = path.join(fixtureRoot, "app");
  const pageADir = path.join(appDir, "a");
  const pageBDir = path.join(appDir, "b");

  await fs.mkdir(pageADir, { recursive: true });
  await fs.mkdir(pageBDir, { recursive: true });
  await fs.symlink(
    path.resolve(process.cwd(), "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
  await fs.copyFile(
    path.resolve(
      process.cwd(),
      "tests/fixtures/app-basic/app/script-nonce/with-next-font/font.woff2",
    ),
    path.join(appDir, "font.woff2"),
  );

  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(fixtureRoot, "next.config.ts"),
    `export default {
  experimental: {
    inlineCss: true,
  },
};
`,
  );
  await fs.writeFile(
    path.join(appDir, "global.css"),
    `p {
  color: yellow;
}

body {
  font-family: var(--font-1);
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "font.ts"),
    `import localFont from "next/font/local";

export const font = localFont({
  src: "./font.woff2",
  variable: "--font-1",
});
`,
  );
  await fs.writeFile(
    path.join(appDir, "layout.tsx"),
    `import Link from "next/link";
import { font } from "./font";
import "./global.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html className={font.variable}>
      <head>
        <link rel="icon" href="data:," />
      </head>
      <body>
        <nav>
          <Link href="/">Home</Link>
          <Link href="/a" id="link-a">Page A</Link>
          <Link href="/b" id="link-b">Page B</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
`,
  );
  await fs.writeFile(
    path.join(appDir, "page.tsx"),
    `import { font } from "./font";

export default function Page() {
  return (
    <div>
      <p id="home">Home</p>
      <p id="with-font" className={font.className}>
        Text with custom font
      </p>
    </div>
  );
}
`,
  );
  await fs.writeFile(
    path.join(pageADir, "styles.css"),
    `.page {
  font-size: 100px;
}
`,
  );
  await fs.writeFile(
    path.join(pageADir, "page.tsx"),
    `import "./styles.css";

export const dynamic = "force-dynamic";

export default function PageA() {
  return (
    <div id="page-a" className="page">
      Page A
    </div>
  );
}
`,
  );
  await fs.writeFile(
    path.join(pageBDir, "page.tsx"),
    `import "../global.css";

export const dynamic = "force-dynamic";

export default function PageB() {
  return <p id="page-b">Page B</p>;
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

async function buildAndServeInlineCssFixture(): Promise<ProductionApp> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-"));
  await writeInlineCssFixture(fixtureRoot);

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
const test = base.extend<{ inlineCssApp: ProductionApp }>({
  inlineCssApp: async ({ page }, use) => {
    const app = await buildAndServeInlineCssFixture();

    try {
      await use(app);
    } finally {
      // Close the page before the server: Link prefetches are scheduled via
      // requestIdleCallback and can fire after the test body finishes, hitting
      // a closed port and logging ERR_CONNECTION_REFUSED to the console.
      await page.close();
      await closeServer(app.server);
      await fs.rm(app.fixtureRoot, { recursive: true, force: true });
    }
  },
});
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

test.setTimeout(90_000);

test.describe("App Router experimental.inlineCss production parity", () => {
  // Ported from Next.js: test/e2e/app-dir/app-inline-css/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-inline-css/index.test.ts
  test("inlines CSS in HTML while keeping dynamic RSC navigations free of inline CSS bodies", async ({
    page,
    consoleErrors,
    inlineCssApp,
  }) => {
    await page.goto(`${inlineCssApp.baseUrl}/`, { waitUntil: "load" });

    const inlineStyleText = await page
      .locator("style")
      .first()
      .evaluate((style) => style.textContent ?? "");
    expect(inlineStyleText).toContain("color");
    expect(inlineStyleText).toContain("@font-face");
    const fontUrl = inlineStyleText.match(/src:\s*url\(['"]?([^)'"]+)/)?.[1];
    expect(fontUrl).toBeTruthy();
    const fontResponse = await page.request.get(
      new URL(fontUrl ?? "", inlineCssApp.baseUrl).toString(),
    );
    expect(fontResponse.status()).toBe(200);
    expect(fontResponse.headers()["content-type"]).toContain("font");
    await expect(page.locator("#home")).toHaveCSS("color", "rgb(255, 255, 0)");

    const rscPayload = await (
      await page.request.get(`${inlineCssApp.baseUrl}/a?_rsc`, {
        headers: {
          rsc: "1",
        },
      })
    ).text();
    expect(rscPayload).toContain("__route");
    expect(rscPayload).not.toContain("font-size");

    const htmlPayload = await (await page.request.get(`${inlineCssApp.baseUrl}/a?_rsc`)).text();
    expect(htmlPayload).toContain("font-size");

    await page.locator("#link-b").click();
    await expect(page.locator("#page-b")).toBeVisible();
    await expect(page.locator("style")).toHaveCount(1);
    const stylesheetLinks = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((links) => links.map((link) => link.outerHTML));
    expect(stylesheetLinks).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
