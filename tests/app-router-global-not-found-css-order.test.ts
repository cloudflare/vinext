/**
 * Regression test for issue #1549 — production CSS ordering for
 * `app/global-not-found.tsx`.
 *
 * Ported from Next.js:
 * test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
 * (the `should serve styles in the correct order for global-not-found` case)
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
 *
 * Why a *production* build test (not the dev-server SSR test in
 * tests/nextjs-compat/global-not-found.test.ts):
 *
 * The bug only manifests in the production RSC build. There are two
 * complementary leak vectors:
 *
 * 1. When the root layout and `app/global-not-found.tsx` import the same
 *    stylesheet, Vite/Rolldown can dedupe the shared import into the layout's
 *    CSS bundle. The fix isolates global-not-found side-effect stylesheet
 *    imports with a private query so the 404 document owns its shared CSS
 *    resource separately.
 * 2. When global-not-found imports only its own distinct CSS, it can still
 *    inherit the root layout's CSS through the shared RSC/framework chunk. The
 *    `createRscFrameworkChunkOutputConfig` split keeps that shared chunk
 *    CSS-free.
 *
 * Fixture: tests/fixtures/global-not-found-css-order/
 *   - layout.tsx imports red.css then green.css -> green wins (matched routes)
 *   - global-not-found.tsx imports the same red.css plus its own gnf-a.css and
 *     gnf-b.css -> red must win on route-miss 404s, including the literal /404
 *     path, and global-not-found-only assets must not leak onto matched routes.
 *
 * Assertions mirror upstream: the 404 document must link ONLY
 * global-not-found's stylesheet and must NOT carry the root layout's green
 * stylesheet.
 *
 * The fixture also includes a lazy `react-dom/server.edge` import for issue
 * #2073. Importing the production RSC entry must not eagerly evaluate React's
 * throwing server-component stub.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/global-not-found-css-order");

/**
 * Extract the contents of every `<link rel="stylesheet">` href in document
 * order. CSS cascade is order-sensitive, so order matters for the assertion.
 */
function extractCssLinks(html: string): string[] {
  const hrefs: string[] = [];
  const linkRe = /<link\b[^>]*\brel="stylesheet"[^>]*>/gi;
  for (const m of html.matchAll(linkRe)) {
    const hrefMatch = /\bhref="([^"]+)"/i.exec(m[0]);
    if (hrefMatch) hrefs.push(hrefMatch[1]);
  }
  return hrefs;
}

/**
 * Read the built CSS bundle for a given stylesheet href so we can assert on
 * the *rule* that wins, independent of hashed filenames. Hrefs look like
 * `/_next/static/<hash>.css`; map them onto the client output tree.
 */
function readCssAsset(clientDir: string, href: string): string {
  const rel = href.replace(/^\//, "");
  const full = path.join(clientDir, rel);
  return fs.readFileSync(full, "utf-8");
}

async function buildFixture(fixtureDir: string): Promise<void> {
  const builder = await createBuilder({
    root: fixtureDir,
    configFile: false,
    plugins: [vinext({ appDir: fixtureDir })],
    logLevel: "silent",
  });
  await builder.buildApp();
}

async function startFixturePreview(fixtureDir: string): Promise<{
  server: Awaited<ReturnType<typeof preview>>;
  baseUrl: string;
}> {
  const server = await preview({
    root: fixtureDir,
    configFile: false,
    plugins: [vinext({ appDir: fixtureDir })],
    preview: { port: 0 },
    logLevel: "silent",
  });
  const addr = server.httpServer.address();
  const baseUrl = addr && typeof addr === "object" ? `http://localhost:${addr.port}` : "";
  expect(baseUrl).not.toBe("");
  return { server, baseUrl };
}

async function transformGlobalNotFoundMdx(root: string, code: string): Promise<string | null> {
  const appDir = path.join(root, "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "global-not-found.mdx"), code);
  fs.writeFileSync(
    path.join(root, "next.config.ts"),
    `export default {
  pageExtensions: ["mdx", "tsx", "ts", "jsx", "js"],
  experimental: {
    globalNotFound: true,
  },
};
`,
  );

  const plugins = vinext({ appDir: root }) as any[];
  const configPlugin = plugins.find((p) => p.name === "vinext:config");
  const isolationPlugin = plugins.find((p) => p.name === "vinext:global-not-found-css-isolation");
  expect(configPlugin).toBeDefined();
  expect(isolationPlugin).toBeDefined();

  await configPlugin.config({ root, plugins: [] }, { command: "build", mode: "production" });
  const result = await isolationPlugin.transform.handler.call(
    isolationPlugin,
    code,
    path.join(appDir, "global-not-found.mdx"),
    {},
  );
  if (!result) return null;
  return typeof result === "string" ? result : result.code;
}

describe("App Router: global-not-found CSS order (production, #1549)", () => {
  const distDir = path.resolve(FIXTURE_DIR, "dist");
  const clientDir = path.join(distDir, "client");
  let previewServer: Awaited<ReturnType<typeof preview>>;
  let baseUrl: string;
  let startupImportValidated = false;

  beforeAll(async () => {
    await buildFixture(FIXTURE_DIR);
  }, 120_000);

  async function startPreviewServer(): Promise<void> {
    if (!startupImportValidated) {
      throw new Error("The direct RSC entry import assertion must run before preview startup");
    }
    if (previewServer) return;
    const started = await startFixturePreview(FIXTURE_DIR);
    previewServer = started.server;
    baseUrl = started.baseUrl;
  }

  afterAll(() => {
    previewServer?.httpServer.close();
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it("does not eagerly evaluate dynamically imported React server stubs", async () => {
    const entryUrl = pathToFileURL(path.join(distDir, "server", "index.js"));
    entryUrl.searchParams.set("test", String(Date.now()));

    await expect(import(entryUrl.href)).resolves.toBeDefined();
    startupImportValidated = true;
  });

  it("matched routes serve the root layout's CSS (green wins)", async () => {
    await startPreviewServer();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const links = extractCssLinks(html);
    // The home page is wrapped by the root layout, so its CSS must be present.
    expect(links.length).toBeGreaterThanOrEqual(1);
    const css = links.map((h) => readCssAsset(clientDir, h)).join("\n");
    expect(css).toContain("--shared-red-css");
    expect(css).toContain("--layout-green-css");
    expect(css).toContain("green");
    expect(css).not.toContain("--global-not-found-a-css");
    expect(css).not.toContain("--global-not-found-b-css");
  });

  it("route-miss 404 serves global-not-found's CSS with red winning, and no layout CSS leak", async () => {
    await startPreviewServer();
    for (const pathname of ["/does-not-exist", "/404"]) {
      const res = await fetch(`${baseUrl}${pathname}`);
      expect(res.status).toBe(404);
      const html = await res.text();
      // global-not-found.tsx ships its own document.
      expect(html).toContain('data-global-not-found="true"');

      const links = extractCssLinks(html);
      expect(links.length).toBeGreaterThanOrEqual(1);

      const cssByHref = new Map(links.map((h) => [h, readCssAsset(clientDir, h)]));
      const allCss = [...cssByHref.values()].join("\n");

      // The literal upstream failure path is /404. The global-not-found module
      // imports the same red.css as the root layout, so production builds must
      // isolate that import instead of linking the layout bundle where green
      // wins the cascade. It also imports gnf-a.css/gnf-b.css so this keeps
      // coverage for the old framework-chunk leak: layout green must not arrive
      // through a shared RSC/framework chunk either.
      expect(allCss).toContain("--shared-red-css");
      expect(allCss).toContain("--global-not-found-a-css");
      expect(allCss).toContain("--global-not-found-b-css");
      expect(allCss).toContain("background-color:red");
      expect(allCss).not.toContain("--layout-green-css");

      const isolatedSharedRedHref = [...cssByHref].find(
        ([, css]) => css.includes("--shared-red-css") && !css.includes("--layout-green-css"),
      )?.[0];
      expect(isolatedSharedRedHref).toBeDefined();

      const matchedRes = await fetch(`${baseUrl}/`);
      expect(matchedRes.status).toBe(200);
      const matchedLinks = extractCssLinks(await matchedRes.text());
      expect(matchedLinks).not.toContain(isolatedSharedRedHref);
    }
  });

  it("isolates every consecutive semicolon-less MDX stylesheet import", async () => {
    const tmpRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "vinext-gnf-mdx-isolation-")),
    );

    try {
      const transformed = await transformGlobalNotFoundMdx(
        tmpRoot,
        `import "./red.css"
import "./gnf-a.css"
import "./gnf-b.css"

# global-not-found
`,
      );

      expect(transformed).toContain(`"./red.css?vinext-global-not-found-css"`);
      expect(transformed).toContain(`"./gnf-a.css?vinext-global-not-found-css"`);
      expect(transformed).toContain(`"./gnf-b.css?vinext-global-not-found-css"`);

      const sameLine = await transformGlobalNotFoundMdx(
        tmpRoot,
        `import "./red.css"; import "./gnf-a.css";

# global-not-found
`,
      );

      expect(sameLine).toContain(`"./red.css?vinext-global-not-found-css"`);
      expect(sameLine).toContain(`"./gnf-a.css?vinext-global-not-found-css"`);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("matches custom global-not-found extensions without overlapping dot segments", () => {
    const plugins = vinext({ appDir: FIXTURE_DIR }) as any[];
    const isolationPlugin = plugins.find((p) => p.name === "vinext:global-not-found-css-isolation");
    const idFilter = isolationPlugin.transform.filter.id as RegExp;

    expect(idFilter.test("/app/global-not-found.tsx")).toBe(true);
    expect(idFilter.test("/app/global-not-found.mdx")).toBe(true);
    expect(idFilter.test("/app/global-not-found.page.tsx")).toBe(true);
    expect(idFilter.test(String.raw`C:\app\global-not-found.platform.tsx?x=1`)).toBe(true);
    expect(idFilter.test("/app/global-not-found")).toBe(false);
    expect(idFilter.test("/app/other-global-not-found.tsx")).toBe(false);
    expect(idFilter.test(`/app/global-not-found${".".repeat(40)}?x\n`)).toBe(false);
  });

  it("isolates CSS for global-not-found files discovered through custom pageExtensions", async () => {
    const tmpRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "vinext-gnf-css-extension-")),
    );
    const tmpAppDir = path.join(tmpRoot, "app");
    const tmpClientDir = path.join(tmpRoot, "dist", "client");
    let tmpPreviewServer: Awaited<ReturnType<typeof preview>> | undefined;

    try {
      fs.cpSync(FIXTURE_DIR, tmpRoot, { recursive: true });
      fs.writeFileSync(
        path.join(tmpAppDir, "global-not-found.page.tsx"),
        `import "./red.css";
import "./gnf-a.css";
import "./gnf-b.css";

export default function GlobalNotFound() {
  return (
    <html data-global-not-found="true">
      <body>
        <h1 id="global-error-title">global-not-found</h1>
      </body>
    </html>
  );
}
`,
      );
      fs.rmSync(path.join(tmpAppDir, "global-not-found.tsx"));
      fs.rmSync(path.join(tmpRoot, "dist"), { recursive: true, force: true });
      fs.writeFileSync(
        path.join(tmpRoot, "next.config.ts"),
        `export default {
  pageExtensions: ["page.tsx", "tsx", "ts", "jsx", "js"],
  experimental: {
    globalNotFound: true,
  },
};
`,
      );

      await buildFixture(tmpRoot);
      const started = await startFixturePreview(tmpRoot);
      tmpPreviewServer = started.server;

      const res = await fetch(`${started.baseUrl}/404`);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('data-global-not-found="true"');

      const links = extractCssLinks(html);
      expect(links.length).toBeGreaterThanOrEqual(1);
      const css = links.map((h) => readCssAsset(tmpClientDir, h)).join("\n");
      expect(css).toContain("--shared-red-css");
      expect(css).toContain("--global-not-found-b-css");
      expect(css).toContain("background-color:red");
      expect(css).not.toContain("--layout-green-css");
    } finally {
      tmpPreviewServer?.httpServer.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
