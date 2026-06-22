/**
 * Ported from Next.js:
 * - test/e2e/tsconfig-path/index.test.ts
 * - test/e2e/typescript-custom-tsconfig/test/index.test.ts
 *
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/tsconfig-path/index.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ViteDevServer } from "vite-plus";
import { buildAppFixture, buildPagesFixture, fetchHtml, startFixtureServer } from "../helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/custom-tsconfig");
const CUSTOM_TSCONFIG_PARENT_PATH = path.join(FIXTURE_DIR, "config/web.base.json");

async function waitForHtml(baseUrl: string, expected: string[]): Promise<string> {
  const deadline = Date.now() + 10_000;
  let lastHtml = "";
  while (Date.now() < deadline) {
    ({ html: lastHtml } = await fetchHtml(baseUrl, `/?t=${Date.now()}`));
    if (expected.every((marker) => lastHtml.includes(marker))) return lastHtml;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)} in HTML: ${lastHtml}`);
}

describe("Next.js compat: typescript.tsconfigPath dev", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR));
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it.each([
    ["App Router", "/", "app:"],
    ["Pages Router", "/page", "pages:"],
  ])("uses only the custom paths and baseUrl in %s", async (_router, route, marker) => {
    const { res, html } = await fetchHtml(baseUrl, route);
    expect(res.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain("bar123");
    expect(html).toContain("custom-base-url");
    expect(html).not.toContain("wrong-default");
  });

  it("uses only the custom paths and baseUrl in middleware", async () => {
    const res = await fetch(`${baseUrl}/middleware-result`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      value: "bar123",
      baseValue: "custom-base-url",
    });
  });

  it("applies extended parent paths and baseUrl edits without restarting dev", async () => {
    const originalConfig = await fs.readFile(CUSTOM_TSCONFIG_PARENT_PATH, "utf8");
    const pagePath = path.join(FIXTURE_DIR, "app/page.tsx");
    const originalPage = await fs.readFile(pagePath, "utf8");
    const editedBaseUrlDir = path.join(FIXTURE_DIR, "config/edited-src");
    const editedPathFile = path.join(FIXTURE_DIR, "config/edited-bar.ts");
    await fs.mkdir(editedBaseUrlDir, { recursive: true });
    await fs.writeFile(
      path.join(editedBaseUrlDir, "base-value.ts"),
      'export default "edited-base";\n',
    );
    await fs.writeFile(editedPathFile, 'export default "edited-path";\n');

    try {
      await fs.writeFile(
        CUSTOM_TSCONFIG_PARENT_PATH,
        JSON.stringify(
          {
            compilerOptions: {
              baseUrl: "./edited-src",
              paths: { foo: ["../edited-bar.ts"] },
            },
          },
          null,
          2,
        ) + "\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.writeFile(pagePath, originalPage + "\n");

      const html = await waitForHtml(baseUrl, ["app:", "edited-path", "edited-base"]);
      expect(html).not.toContain("bar123");
      expect(html).not.toContain("custom-base-url");
    } finally {
      await fs.writeFile(CUSTOM_TSCONFIG_PARENT_PATH, originalConfig);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await fs.writeFile(pagePath, originalPage);
      await waitForHtml(baseUrl, ["app:", "bar123", "custom-base-url"]);
      await fs.rm(editedBaseUrlDir, { recursive: true, force: true });
      await fs.rm(editedPathFile, { force: true });
    }
  });
});

describe("Next.js compat: typescript.tsconfigPath production", () => {
  let appHandler: (request: Request) => Promise<Response>;
  let pagesEntry: {
    renderPage(
      request: Request,
      url: string,
      manifest: Record<string, string[]>,
    ): Promise<Response>;
    runMiddleware(request: Request): Promise<{
      continue: boolean;
      response?: Response;
    }>;
  };

  beforeAll(async () => {
    const appBundlePath = await buildAppFixture(FIXTURE_DIR);
    const pagesBundlePath = await buildPagesFixture(FIXTURE_DIR);
    await Promise.all([
      fs.symlink("index.mjs", appBundlePath),
      fs.symlink("index.mjs", path.join(path.dirname(appBundlePath), "ssr/index.js")),
    ]);
    const appModule = await import(pathToFileURL(appBundlePath).href);
    appHandler = appModule.default;

    const pagesOutDir = path.dirname(path.dirname(pagesBundlePath));
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(pagesOutDir, "node_modules"),
    );
    pagesEntry = await import(pathToFileURL(pagesBundlePath).href);
  }, 120_000);

  it("serves App Router with the custom paths and baseUrl", async () => {
    const res = await appHandler(new Request("http://localhost/"));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("app:<!-- -->bar123<!-- -->:<!-- -->custom-base-url");
    expect(html).not.toContain("wrong-default");
  });

  it("serves Pages Router with the custom paths and baseUrl", async () => {
    const res = await pagesEntry.renderPage(new Request("http://localhost/page"), "/page", {});
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("pages:<!-- -->bar123<!-- -->:<!-- -->custom-base-url");
    expect(html).not.toContain("wrong-default");
  });

  it("runs middleware with the custom paths and baseUrl", async () => {
    const result = await pagesEntry.runMiddleware(
      new Request("http://localhost/middleware-result"),
    );
    expect(result.continue).toBe(false);
    expect(result.response?.status).toBe(200);
    await expect(result.response?.json()).resolves.toEqual({
      value: "bar123",
      baseValue: "custom-base-url",
    });
  });
});
