/**
 * Ported from Next.js: test/e2e/esm-externals/esm-externals.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/esm-externals/esm-externals.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createBuilder, createServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { createPagesNodeExternalsPlugin } from "../packages/vinext/src/plugins/pages-node-externals.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const FIXTURE_ROOT = path.resolve(import.meta.dirname, "fixtures/esm-externals");

async function renderParagraph(url: string): Promise<string> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const html = (await response.text()).replaceAll("<!-- -->", "");
  const paragraph = /<p>(.*?)<\/p>/.exec(html)?.[1];
  expect(paragraph).toBeDefined();
  return paragraph!;
}

describe("ESM externals", () => {
  it("only applies Pages externalization to eligible server environments", () => {
    let pagesDir: string | null = "/project/pages";
    let enabled = true;
    const plugin = createPagesNodeExternalsPlugin({
      getRoot: () => "/project",
      getPagesDir: () => pagesDir,
      getAliases: () => ({}),
      getTsconfigAliases: () => ({}),
      getBundledPackages: () => new Set(),
      isEnabled: () => enabled,
    });
    const applyToEnvironment = plugin.applyToEnvironment!;
    const environment = (name: string, consumer: "client" | "server") =>
      ({ name, config: { consumer } }) as Parameters<typeof applyToEnvironment>[0];

    expect(applyToEnvironment(environment("rsc", "server"))).toBe(true);
    expect(applyToEnvironment(environment("ssr", "server"))).toBe(true);
    expect(applyToEnvironment(environment("client", "server"))).toBe(false);
    expect(applyToEnvironment(environment("custom-client", "client"))).toBe(false);

    pagesDir = null;
    expect(applyToEnvironment(environment("rsc", "server"))).toBe(false);

    pagesDir = "/project/pages";
    enabled = false;
    expect(applyToEnvironment(environment("rsc", "server"))).toBe(false);
  });

  it("skips canonical ownership work in App-only builds", async () => {
    const realpathSpy = vi.spyOn(fs.realpathSync, "native");
    const resolve = vi.fn();
    const plugin = createPagesNodeExternalsPlugin({
      getRoot: () => "/project",
      getPagesDir: () => null,
      getAliases: () => ({}),
      getTsconfigAliases: () => ({}),
      getBundledPackages: () => new Set(),
      isEnabled: () => true,
    });
    const context = { environment: { name: "rsc" }, resolve } as any;

    try {
      const transform = plugin.transform as { handler: (code: string, id: string) => unknown };
      const resolveId = plugin.resolveId as {
        handler: (id: string, importer: string) => unknown;
      };
      await transform.handler.call(context, 'import value from "some-package";', "/app/page.js");
      await resolveId.handler.call(context, "some-package", "/app/page.js");

      expect(realpathSpy).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("keeps native ESM dependencies inside Vite's dev module runner", async () => {
    const root = FIXTURE_ROOT;
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: root })],
      server: { port: 0 },
    });

    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Missing dev server address");
      const response = await fetch(`http://localhost:${address.port}/static`);
      expect(response.status).toBe(200);
      expect((await response.text()).replaceAll("<!-- -->", "")).toContain(
        "Hello World+World+World+World+World+World",
      );
    } finally {
      await server.close();
    }
  }, 60_000);

  it("builds and renders the mixed App and Pages Router fixture with import conditions", async () => {
    const root = FIXTURE_ROOT;
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: root })],
    });
    await builder.buildApp();

    const result = await startProdServer({
      host: "127.0.0.1",
      port: 0,
      outDir: path.join(root, "dist"),
    });
    const server = "server" in result ? result.server : result;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      for (const route of ["static", "ssr", "ssg"]) {
        expect(await renderParagraph(`http://127.0.0.1:${address.port}/${route}`)).toBe(
          "Hello World+World+World+World+World+World",
        );
      }
      expect(await renderParagraph(`http://127.0.0.1:${address.port}/aliased`)).toBe(
        "Aliased World+World+World",
      );
      for (const route of ["server", "client"]) {
        expect(await renderParagraph(`http://127.0.0.1:${address.port}/${route}`)).toBe(
          "Hello World+World+World",
        );
      }
      expect(await renderParagraph(`http://127.0.0.1:${address.port}/app-shared`)).toBe("App:RSC");
      expect(await renderParagraph(`http://127.0.0.1:${address.port}/pages-shared`)).toBe(
        "Pages:DEFAULT",
      );
      expect(await renderParagraph(`http://127.0.0.1:${address.port}/dynamic`)).toBe(
        "Dynamic:LITERAL+DYNAMIC",
      );
      expect(await renderParagraph(`http://127.0.0.1:${address.port}/bundled-packages`)).toBe(
        "DEFAULT_TRANSPILED+OPTIMIZED+EXPLICIT",
      );
      expect(await renderParagraph(`http://127.0.0.1:${address.port}/mdx-ownership`)).toBe(
        "MDX:MDX_EXTERNAL",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const clientCode = fs
      .readdirSync(path.join(root, "dist", "client", "_next", "static", "chunks"))
      .filter((file) => file.endsWith(".js"))
      .map((file) =>
        fs.readFileSync(
          path.join(root, "dist", "client", "_next", "static", "chunks", file),
          "utf8",
        ),
      )
      .join("\n");
    expect(clientCode).not.toContain("process.browser");
    expect(clientCode).not.toContain("Browser only");

    const externals = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "server", "vinext-externals.json"), "utf8"),
    ) as string[];
    expect(externals).toEqual(
      expect.arrayContaining([
        "esm-package1",
        "esm-package2",
        "app-esm-package1",
        "app-esm-package2",
        "app-cjs-esm-package",
      ]),
    );
    expect(externals).not.toContain("invalid-esm-package");
    expect(externals).toContain("dynamic-esm-package");
    expect(externals).toContain("literal-dynamic-esm-package");
    expect(externals).toContain("mdx-esm-package");
    expect(externals).not.toContain("geist");
    expect(externals).not.toContain("optimized-esm-package");
    expect(externals).not.toContain("explicit-esm-package");
  }, 60_000);
});
