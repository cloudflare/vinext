/**
 * Ported from Next.js: test/e2e/esm-externals/esm-externals.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/esm-externals/esm-externals.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

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
  const { default: value } = await import("@shared/dynamic-world.js");
  return { props: { value } };
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
  return root;
}

describe("ESM externals", () => {
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
      expect(dynamic.replaceAll("<!-- -->", "")).toContain("Dynamic:DYNAMIC");
      const bundledPackages = await (
        await fetch(`http://127.0.0.1:${address.port}/bundled-packages`)
      ).text();
      expect(bundledPackages.replaceAll("<!-- -->", "")).toContain(
        "DEFAULT_TRANSPILED+OPTIMIZED+EXPLICIT",
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
    expect(externals).toContain("dynamic-esm-package");
    expect(externals).not.toContain("geist");
    expect(externals).not.toContain("optimized-esm-package");
    expect(externals).not.toContain("explicit-esm-package");
  }, 60_000);
});
