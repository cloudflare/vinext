/**
 * Ported from Next.js: test/e2e/esm-externals/esm-externals.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/esm-externals/esm-externals.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { createBuilder, createServer } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { createPagesNodeExternalsPlugin } from "../packages/vinext/src/plugins/pages-node-externals.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";
import { shouldExternalizeMissingFixtureImport } from "./fixtures/cf-esm-externals/esm-externals-test-plugin.js";

const WORKSPACE_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

function writeFile(root: string, name: string, contents: string): void {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writePackage(
  root: string,
  name: string,
  manifest: object,
  files: Record<string, string>,
): void {
  writeFile(root, `node_modules/${name}/package.json`, JSON.stringify({ name, ...manifest }));
  for (const [file, contents] of Object.entries(files)) {
    writeFile(root, `node_modules/${name}/${file}`, contents);
  }
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-esm-externals-"));
  fixtureRoots.push(root);
  writeFile(root, "package.json", JSON.stringify({ type: "module" }));
  writeFile(
    root,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["lib/*"] } } }),
  );
  fs.mkdirSync(path.join(root, "node_modules"));
  for (const dependency of ["react", "react-dom", "styled-jsx"]) {
    fs.symlinkSync(
      path.join(WORKSPACE_NODE_MODULES, dependency),
      path.join(root, "node_modules", dependency),
      "junction",
    );
  }

  for (const prefix of ["", "app-"]) {
    writePackage(
      root,
      `${prefix}esm-package1`,
      {
        exports: {
          "./entry": {
            browser: "./browser.mjs",
            import: "./correct.mjs",
            require: "./wrong.js",
          },
        },
      },
      {
        "browser.mjs":
          'export default "World"; if (!process.browser) throw new Error("Browser only");',
        "correct.mjs": 'export default "World"; if (Math.random() < 0) import("fail");',
        "wrong.js": 'module.exports = "Wrong";',
      },
    );
    writePackage(
      root,
      `${prefix}esm-package2`,
      {
        type: "module",
        exports: {
          "./entry": {
            browser: "./browser.mjs",
            import: "./correct.js",
            require: "./wrong.cjs",
          },
        },
      },
      {
        "browser.mjs":
          'export default "World"; if (!process.browser) throw new Error("Browser only");',
        "correct.js": 'await 1; export default "World"; if (Math.random() < 0) import("fail");',
        "wrong.cjs": 'module.exports = "Wrong";',
      },
    );
  }

  writePackage(
    root,
    "invalid-esm-package",
    {
      exports: {
        "./entry": {
          browser: "./browser.js",
          import: "./correct.js",
          require: "./alternative.js",
        },
      },
    },
    {
      "browser.js":
        'export default "World"; if (!process.browser) throw new Error("Browser only");',
      "correct.js": 'export default "World";',
      "alternative.js": 'module.exports = "Alternative";',
    },
  );
  writePackage(
    root,
    "app-cjs-esm-package",
    {
      exports: {
        "./entry": {
          browser: "./browser.js",
          import: "./correct.js",
          require: "./alternative.js",
        },
      },
    },
    {
      "browser.js":
        'export default "World"; if (!process.browser) throw new Error("Browser only");',
      "correct.js": 'module.exports = "World"; if (Math.random() < 0) require("fail");',
      "alternative.js": 'module.exports = "Alternative";',
    },
  );
  writePackage(
    root,
    "shared-condition-package",
    {
      exports: {
        ".": {
          "react-server": "./rsc.mjs",
          import: "./default.mjs",
        },
      },
    },
    {
      "rsc.mjs": 'export default "RSC";',
      "default.mjs": 'export default "DEFAULT";',
    },
  );
  writePackage(
    root,
    "dynamic-esm-package",
    { exports: { "./entry": { import: "./entry.mjs" } } },
    {
      "entry.mjs":
        'export default "DYNAMIC"; if (Math.random() < 0) import("dynamic-import-fail");',
    },
  );
  writePackage(
    root,
    "literal-dynamic-esm-package",
    { exports: { "./entry": { import: "./entry.mjs" } } },
    {
      "entry.mjs":
        'export default "LITERAL"; if (Math.random() < 0) import("literal-dynamic-import-fail");',
    },
  );
  writePackage(
    root,
    "mdx-esm-package",
    {
      exports: {
        "./entry": { browser: "./browser.mjs", import: "./entry.mjs" },
      },
    },
    {
      "browser.mjs": 'export default "MDX_EXTERNAL";',
      "entry.mjs":
        'export default "MDX_EXTERNAL"; if (Math.random() < 0) import("mdx-import-fail");',
    },
  );
  for (const [name, value] of [
    ["geist", "DEFAULT_TRANSPILED"],
    ["optimized-esm-package", "OPTIMIZED"],
    ["explicit-esm-package", "EXPLICIT"],
  ]) {
    writePackage(
      root,
      name,
      { exports: { "./entry": { import: "./entry.mjs" } } },
      { "entry.mjs": `export default ${JSON.stringify(value)};` },
    );
  }

  writeFile(
    root,
    "next.config.mjs",
    `export default {
  pageExtensions: ["js", "jsx", "ts", "tsx", "mdx"],
  serverExternalPackages: ["app-esm-package1", "app-esm-package2", "app-cjs-esm-package"],
  transpilePackages: ["explicit-esm-package"],
  experimental: { optimizePackageImports: ["optimized-esm-package"] },
  turbopack: { resolveAlias: { "preact/compat": "react" } },
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, "preact/compat": "react" };
    return config;
  },
};`,
  );
  writeFile(
    root,
    "app/layout.js",
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
  );
  const appImports = `import World1 from "app-esm-package1/entry";
import World2 from "app-esm-package2/entry";
import World3 from "app-cjs-esm-package/entry";`;
  for (const [route, directive] of [
    ["server", ""],
    ["client", '"use client";'],
  ]) {
    writeFile(
      root,
      `app/${route}/page.js`,
      `${directive}\n${appImports}\nexport default function Page() { return <p>Hello {World1}+{World2}+{World3}</p>; }`,
    );
  }
  writeFile(
    root,
    "lib/shared-condition.js",
    'import value from "shared-condition-package"; export default value;',
  );
  writeFile(
    root,
    "lib/dynamic-world.js",
    'import value from "dynamic-esm-package/entry"; export default value;',
  );
  writeFile(
    root,
    "lib/literal-dynamic-world.js",
    'import value from "literal-dynamic-esm-package/entry"; export default value;',
  );
  writeFile(
    root,
    "app/app-shared/page.js",
    'import value from "../../lib/shared-condition.js"; export default function Page() { return <p>App:{value}</p>; }',
  );

  writeFile(
    root,
    "lib/pages-worlds.js",
    `import World1 from "esm-package1/entry";
import World2 from "esm-package2/entry";
import World3 from "invalid-esm-package/entry";
export { World1, World2, World3 };`,
  );
  const pagesImports = `import React from "preact/compat";
import { World1, World2, World3 } from "@shared/pages-worlds.js";`;
  writeFile(
    root,
    "pages/static.js",
    `${pagesImports}\nexport default function Page() { return <p>Hello {World1}+{World2}+{World3}+World+World+World</p>; }`,
  );
  for (const [route, loader] of [
    ["ssr", "getServerSideProps"],
    ["ssg", "getStaticProps"],
  ]) {
    writeFile(
      root,
      `pages/${route}.js`,
      `${pagesImports}
export function ${loader}() { return { props: { worlds: [World1, World2, World3].join("+") } }; }
export default function Page({ worlds }) { return <p>Hello {World1}+{World2}+{World3}+{worlds}</p>; }`,
    );
  }
  writeFile(
    root,
    "pages/pages-shared.js",
    'import value from "@shared/shared-condition.js"; export default function Page() { return <p>Pages:{value}</p>; }',
  );
  writeFile(
    root,
    "pages/dynamic.js",
    `export async function getServerSideProps() {
  const [{ default: literal }, { default: template }] = await Promise.all([
    import("@shared/literal-dynamic-world.js"),
    import(\`@shared/dynamic-world.js\`),
  ]);
  return { props: { value: literal + "+" + template } };
}
export default function Page({ value }) { return <p>Dynamic:{value}</p>; }`,
  );
  writeFile(
    root,
    "pages/bundled-packages.js",
    `import defaultTranspiled from "geist/entry";
import optimized from "optimized-esm-package/entry";
import explicit from "explicit-esm-package/entry";
export default function Page() { return <p>{defaultTranspiled}+{optimized}+{explicit}</p>; }`,
  );
  writeFile(
    root,
    "lib/external-content.mdx",
    `import World from "mdx-esm-package/entry"

export const world = World

# Shared MDX content`,
  );
  writeFile(
    root,
    "pages/mdx-ownership.mdx",
    `import { world } from "../lib/external-content.mdx"

<p>MDX:{world}</p>`,
  );
  return root;
}

describe("ESM externals", () => {
  it("limits the Worker missing-module sentinel to its dedicated fixture package", () => {
    const sourceImporter =
      "/repo/tests/fixtures/cf-esm-externals/__test_packages__/fake-worker-context-lib/correct.mjs";
    const installedImporter =
      "C:\\repo\\node_modules\\.pnpm\\fake-worker-context-lib@file+tests+fixtures+cf-esm-externals+__test_packages__+fake-worker-context-lib\\node_modules\\fake-worker-context-lib\\correct.mjs";

    expect(shouldExternalizeMissingFixtureImport("fail", sourceImporter)).toBe(true);
    expect(shouldExternalizeMissingFixtureImport("fail", installedImporter)).toBe(true);
    expect(shouldExternalizeMissingFixtureImport("another-missing-module", sourceImporter)).toBe(
      false,
    );
    expect(
      shouldExternalizeMissingFixtureImport(
        "fail",
        "/repo/node_modules/unrelated-package/index.mjs",
      ),
    ).toBe(false);
    expect(shouldExternalizeMissingFixtureImport("fail", undefined)).toBe(false);
  });

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
    const root = createFixture();
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
    const root = createFixture();
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
        const html = (
          await (await fetch(`http://127.0.0.1:${address.port}/${route}`)).text()
        ).replaceAll("<!-- -->", "");
        expect(html).toContain("Hello World+World+World+World+World+World");
      }
      for (const route of ["server", "client"]) {
        const html = (
          await (await fetch(`http://127.0.0.1:${address.port}/${route}`)).text()
        ).replaceAll("<!-- -->", "");
        expect(html).toContain("Hello World+World+World");
      }
      const appShared = await (await fetch(`http://127.0.0.1:${address.port}/app-shared`)).text();
      expect(appShared.replaceAll("<!-- -->", "")).toContain("App:RSC");
      const pagesShared = await (
        await fetch(`http://127.0.0.1:${address.port}/pages-shared`)
      ).text();
      expect(pagesShared.replaceAll("<!-- -->", "")).toContain("Pages:DEFAULT");
      const dynamic = await (await fetch(`http://127.0.0.1:${address.port}/dynamic`)).text();
      expect(dynamic.replaceAll("<!-- -->", "")).toContain("Dynamic:LITERAL+DYNAMIC");
      const bundledPackages = await (
        await fetch(`http://127.0.0.1:${address.port}/bundled-packages`)
      ).text();
      expect(bundledPackages.replaceAll("<!-- -->", "")).toContain(
        "DEFAULT_TRANSPILED+OPTIMIZED+EXPLICIT",
      );
      const mdxOwnership = await (
        await fetch(`http://127.0.0.1:${address.port}/mdx-ownership`)
      ).text();
      expect(mdxOwnership.replaceAll("<!-- -->", "")).toContain("MDX:MDX_EXTERNAL");
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
    expect(externals).toContain("dynamic-esm-package");
    expect(externals).toContain("literal-dynamic-esm-package");
    expect(externals).toContain("mdx-esm-package");
    expect(externals).not.toContain("geist");
    expect(externals).not.toContain("optimized-esm-package");
    expect(externals).not.toContain("explicit-esm-package");
  }, 60_000);
});
