import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStyledJsxPlugin } from "../packages/vinext/src/plugins/styled-jsx.js";
import { startFixtureServer } from "./helpers.js";

function getTransform(transpilePackages: readonly string[] = []) {
  const transform = createStyledJsxPlugin({
    getTranspilePackages: () => transpilePackages,
  }).transform;
  if (!transform || typeof transform === "function") throw new Error("Expected transform handler");
  return transform.handler;
}

describe("styled-jsx transform", () => {
  it("compiles and scopes Pages Router style jsx blocks", async () => {
    // Ported from Next.js: test/e2e/streaming-ssr/streaming-ssr/pages/index.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/streaming-ssr/streaming-ssr/pages/index.js
    const source = `
      export default function Page() {
        return <div><style jsx>{\`p { color: blue; }\`}</style><p>index</p></div>
      }
    `;

    const result = await getTransform().call({} as never, source, "/app/pages/index.js", {
      moduleType: "js",
    });

    expect(result).toBeTruthy();
    expect(typeof result === "object" && result ? result.code : "").toMatch(/color:blue/);
    expect(typeof result === "object" && result ? result.code : "").toContain("styled-jsx/style");
    expect(typeof result === "object" && result ? result.code : "").toMatch(/className=.*jsx-/);
  });

  it("skips files without style jsx blocks", async () => {
    const result = await getTransform().call(
      {} as never,
      "export default function Page() { return <p>plain</p> }",
      "/app/pages/index.tsx",
      { moduleType: "js" },
    );

    expect(result).toBeUndefined();
  });

  it("compiles external styled-jsx/css resolve modules and returns a source map", async () => {
    // Ported from Next.js: test/e2e/app-dir/use-server-inserted-html/app/css-in-js/styled-jsx.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-server-inserted-html/app/css-in-js/styled-jsx.js
    const source = `
      import css from "styled-jsx/css";
      const accent: string = "hotpink";
      export const elementStyles = css\`
        .external-element { background: yellow; }
      \`;
      export const externalStyles = css.resolve\`
        .external { color: \${accent}; }
      \`;
    `;

    const result = await getTransform().call({} as never, source, "/app/styles.ts", {
      moduleType: "js",
    });

    expect(result).toBeTruthy();
    expect(typeof result === "object" && result ? result.code : "").toContain(
      'const accent = "hotpink"',
    );
    expect(typeof result === "object" && result ? result.code : "").toContain("color:${accent}");
    expect(typeof result === "object" && result ? result.code : "").not.toContain("<_JSXStyle");
    expect(typeof result === "object" && result ? result.code : "").toMatch(
      /background:(?:yellow|#ff0)/,
    );
    expect(typeof result === "object" && result ? result.code : "").toContain("className");
    expect(typeof result === "object" && result ? result.map : null).toBeTruthy();
  });

  it("compiles raw styled-jsx from transpilePackages dependencies", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-styled-jsx-packages-"));
    const installedPackage = path.join(fixtureRoot, "node_modules", "raw-styled-jsx");
    const workspacePackage = path.join(fixtureRoot, "packages", "raw-styled-jsx");
    const workspaceLink = path.join(fixtureRoot, "node_modules", "@workspace", "raw-styled-jsx");
    const source = `
      export function RawPackageComponent() {
        return <div><style jsx>{\`p { color: green; }\`}</style><p>package</p></div>
      }
    `;
    try {
      await fsp.mkdir(installedPackage, { recursive: true });
      await fsp.mkdir(workspacePackage, { recursive: true });
      await fsp.mkdir(path.dirname(workspaceLink), { recursive: true });
      await fsp.writeFile(path.join(installedPackage, "index.tsx"), source);
      await fsp.writeFile(path.join(workspacePackage, "index.tsx"), source);
      await fsp.symlink(workspacePackage, workspaceLink, "junction");

      const transform = getTransform(["raw-styled-jsx", "@workspace/raw-styled-jsx"]);
      const installedId = path.join(installedPackage, "index.tsx");
      const workspaceId = path.join(workspaceLink, "index.tsx");
      const installedResult = await transform.call(
        {} as never,
        await fsp.readFile(installedId, "utf8"),
        installedId,
        { moduleType: "js" },
      );
      const workspaceResult = await transform.call(
        {} as never,
        await fsp.readFile(workspaceId, "utf8"),
        workspaceId,
        { moduleType: "js" },
      );

      expect(
        typeof installedResult === "object" && installedResult ? installedResult.code : "",
      ).toContain("styled-jsx/style");
      expect(
        typeof workspaceResult === "object" && workspaceResult ? workspaceResult.code : "",
      ).toContain("styled-jsx/style");
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("compiles transpilePackages styled-jsx through the dev server", async () => {
    // Next.js sends transpilePackages dependencies through its normal compiler:
    // packages/next/src/build/webpack-config.ts and next-swc-loader.ts.
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-styled-jsx-dev-"));
    const packageRoot = path.join(fixtureRoot, "node_modules", "raw-styled-jsx");
    let server: Awaited<ReturnType<typeof startFixtureServer>>["server"] | undefined;

    try {
      await fsp.mkdir(path.join(fixtureRoot, "pages"), { recursive: true });
      await fsp.mkdir(path.join(fixtureRoot, "node_modules"));
      const rootNodeModules = path.join(process.cwd(), "node_modules");
      for (const entry of await fsp.readdir(rootNodeModules)) {
        if (entry.startsWith(".")) continue;
        await fsp.symlink(
          path.join(rootNodeModules, entry),
          path.join(fixtureRoot, "node_modules", entry),
          "junction",
        );
      }
      await fsp.mkdir(packageRoot, { recursive: true });
      await fsp.writeFile(
        path.join(fixtureRoot, "next.config.mjs"),
        `export default { transpilePackages: ["raw-styled-jsx"] };\n`,
      );
      await fsp.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "raw-styled-jsx", type: "module", exports: "./index.jsx" }),
      );
      await fsp.writeFile(
        path.join(packageRoot, "index.jsx"),
        `export function PackageComponent() {
  return <div><style jsx>{\`p { color: rgb(1, 2, 3); }\`}</style><p>transpiled package</p></div>;
}\n`,
      );
      await fsp.writeFile(
        path.join(fixtureRoot, "pages", "index.jsx"),
        `import { PackageComponent } from "raw-styled-jsx";
export default function Page() { return <PackageComponent />; }\n`,
      );

      const started = await startFixtureServer(fixtureRoot, {
        appDir: null,
        pluginsBefore: [
          {
            name: "test:conflicting-optimize-deps-include",
            config() {
              return {
                optimizeDeps: {
                  include: ["react", "raw-styled-jsx"],
                },
              };
            },
          },
        ],
      });
      server = started.server;
      const pageResponse = await fetch(`${started.baseUrl}/`);
      const html = await pageResponse.text();

      expect(pageResponse.status).toBe(200);
      expect(html).toContain("transpiled package");
      expect(html).toContain("rgb(1,2,3)");
      expect(html).toMatch(/class="jsx-[^"]+"/);

      const clientEnvironment = server.environments.client;
      const resolvedPackage = await clientEnvironment.pluginContainer.resolveId(
        "raw-styled-jsx",
        path.join(fixtureRoot, "pages", "index.jsx"),
      );
      expect(resolvedPackage?.id).toContain(path.join("node_modules", "raw-styled-jsx"));
      expect(resolvedPackage?.id).not.toContain(`${path.sep}.vite${path.sep}deps${path.sep}`);
      expect(server.config.optimizeDeps.exclude).toContain("raw-styled-jsx");
      expect(server.config.optimizeDeps.include).toContain("react");
      expect(server.config.optimizeDeps.include).not.toContain("raw-styled-jsx");
      expect(server.environments.client.config.optimizeDeps.exclude).toContain("raw-styled-jsx");
      expect(server.environments.client.config.optimizeDeps.include).toContain("react");
      expect(server.environments.client.config.optimizeDeps.include).not.toContain(
        "raw-styled-jsx",
      );
    } finally {
      await server?.close();
      await fsp.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }, 30000);

  it("skips external, precompiled, and styled-jsx dependency modules", async () => {
    const rawSource = `
      export function ExternalComponent() {
        return <div><style jsx>{\`p { color: red; }\`}</style><p>external</p></div>
      }
    `;
    const precompiledSource = `
      import _JSXStyle from "styled-jsx/style";
      export function PrecompiledComponent() {
        return <div className="jsx-123"><_JSXStyle id="123">{\`p { color: blue; }\`}</_JSXStyle></div>
      }
    `;
    const transform = getTransform(["precompiled-package", "styled-jsx"]);

    await expect(
      transform.call({} as never, rawSource, "/app/node_modules/external-package/index.tsx", {
        moduleType: "js",
      }),
    ).resolves.toBeUndefined();
    await expect(
      transform.call(
        {} as never,
        precompiledSource,
        "/app/node_modules/precompiled-package/index.js",
        { moduleType: "js" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      transform.call({} as never, rawSource, "/app/node_modules/styled-jsx/index.js", {
        moduleType: "js",
      }),
    ).resolves.toBeUndefined();
  });
});
