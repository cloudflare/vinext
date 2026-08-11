import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { APP_FIXTURE_DIR, PAGES_FIXTURE_DIR, startFixtureServer, fetchHtml } from "./helpers.js";

async function writeFixtureFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function visibleTextByTestId(html: string, testId: string): string {
  const attribute = `data-testid="${testId}"`;
  const attributeIndex = html.indexOf(attribute);
  if (attributeIndex === -1) throw new Error(`Missing ${attribute}`);
  const contentStart = html.indexOf(">", attributeIndex);
  const contentEnd = html.indexOf("</", contentStart);
  if (contentStart === -1 || contentEnd === -1) {
    throw new Error(`Missing element content for ${attribute}`);
  }
  return html
    .slice(contentStart + 1, contentEnd)
    .replaceAll("<!-- -->", "")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("CJS interop (App Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders page that uses CJS require() and module.exports", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/basic");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-basic");
    // React SSR may insert comment nodes between text and expressions
    // (e.g. "Random: <!-- -->4"), so use a regex.
    expect(html).toMatch(/Random:.*4/);
  });

  it("renders page that uses CJS require('server-only')", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/server-only");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-server-only");
    expect(html).toContain("This page uses CJS require");
  });
});

describe("CJS interop (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(PAGES_FIXTURE_DIR));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders page that uses CJS require() and module.exports", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/basic");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-basic");
    // Pages Router SSR inserts React comment nodes between text and
    // expressions (e.g. "Random: <!-- -->4"), so use a regex.
    expect(html).toMatch(/Random:.*4/);
  });
});

// Ported from Next.js: test/e2e/app-dir/client-module-with-package-type/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/client-module-with-package-type/index.test.ts
describe("conditional package exports in dev", () => {
  let root: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(import.meta.dirname, ".require-condition-"));
    await Promise.all([
      writeFixtureFile(root, "package.json", JSON.stringify({ private: true, type: "module" })),
      writeFixtureFile(
        root,
        "app/layout.tsx",
        `export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/package.json",
        JSON.stringify({
          name: "lib-cjs",
          type: "commonjs",
          exports: { ".": { import: "./index.mjs", default: "./index.js" } },
        }),
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/index.mjs",
        `"use client"; export default () => "esm";`,
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-cjs/index.js",
        `"use client"; module.exports = () => "cjs";`,
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-esm/package.json",
        JSON.stringify({
          name: "lib-esm",
          type: "module",
          exports: { ".": { require: "./index.cjs", default: "./index.js" } },
        }),
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-esm/index.js",
        `"use client"; export default () => "esm";`,
      ),
      writeFixtureFile(
        root,
        "node_modules/lib-esm/index.cjs",
        `"use client"; module.exports = () => "cjs";`,
      ),
      ...[
        ["import-cjs", `import Library from "lib-cjs";`, "lib-cjs"],
        ["require-cjs", `const Library = require("lib-cjs");`, "lib-cjs"],
        ["import-esm", `import Library from "lib-esm";`, "lib-esm"],
        ["require-esm", `const Library = require("lib-esm");`, "lib-esm"],
      ].map(([route, declaration, label]) =>
        writeFixtureFile(
          root,
          `app/${route}/page.tsx`,
          `${declaration}\nexport default function Page() { return <p data-testid="conditional-result">${label}: <Library /></p>; }`,
        ),
      ),
    ]);
    ({ server, baseUrl } = await startFixtureServer(root));
  }, 30000);

  afterAll(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["/import-cjs", "lib-cjs", "esm"],
    ["/require-cjs", "lib-cjs", "cjs"],
    ["/import-esm", "lib-esm", "esm"],
    ["/require-esm", "lib-esm", "cjs"],
  ])("renders %s from the correct export condition", async (route, label, expected) => {
    const { res, html } = await fetchHtml(baseUrl, route);
    expect(res.status).toBe(200);
    expect(visibleTextByTestId(html, "conditional-result")).toBe(`${label}: ${expected}`);
  });
});
