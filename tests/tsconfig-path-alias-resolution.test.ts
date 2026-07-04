/**
 * Integration tests for tsconfig `paths` → Vite alias conversion.
 *
 * Covers two resolution bugs in the materialized `resolve.alias` entries:
 *
 * 1. Declaration-order shadowing: TypeScript (and Next.js) match `paths`
 *    patterns by longest prefix, regardless of declaration order. Overlapping
 *    patterns like `@/*` + `@/public/*` must resolve `@/public/...` through
 *    the more specific pattern even when `@/*` is declared first.
 *    (Seen on ixartz/Next-js-Boilerplate — every page 500'd.)
 *
 * 2. CSS `@import` hijacking: TypeScript `paths` never apply to CSS in
 *    Next.js — `@import` specifiers in stylesheets use standard bundler
 *    resolution (including package.json `exports`). A tsconfig alias like
 *    `@scope/ui/*` must not rewrite `@import "@scope/ui/globals.css"` inside
 *    a CSS file away from its `exports`-mapped target. JS/TS imports of CSS
 *    files (e.g. `import "@/styles/globals.css"` from a layout) still go
 *    through the alias. (Seen on create-better-t-stack scaffolds — dev 500'd
 *    on every route and the build failed in the analyze step.)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startFixtureServer, fetchHtml } from "./helpers.js";

const tmpDirs: string[] = [];

function writeFixtureFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function linkRepoNodeModules(root: string) {
  const repoNodeModules = path.resolve(import.meta.dirname, "../node_modules");
  try {
    fs.symlinkSync(repoNodeModules, path.join(root, "node_modules"), "dir");
  } catch {
    fs.symlinkSync(repoNodeModules, path.join(root, "node_modules"), "junction");
  }
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("overlapping tsconfig path aliases (longest prefix wins)", () => {
  function writeOverlappingAliasFixture(root: string) {
    linkRepoNodeModules(root);
    writeFixtureFile(
      root,
      "package.json",
      JSON.stringify({ name: "overlapping-alias-fixture", private: true, type: "module" }),
    );
    // `@/*` is intentionally declared BEFORE the more specific `@/public/*`
    // (matching ixartz/Next-js-Boilerplate). TypeScript matches by longest
    // prefix, not declaration order.
    writeFixtureFile(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          paths: {
            "@/*": ["./src/*"],
            "@/public/*": ["./public/*"],
          },
        },
      }),
    );
    writeFixtureFile(
      root,
      "public/assets/images/icon.svg",
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>\n`,
    );
    writeFixtureFile(root, "src/styles/globals.css", `body { background: rgb(250, 250, 249); }\n`);
    writeFixtureFile(
      root,
      "src/lib/greeting.ts",
      `export const greeting = "greeting-through-alias";\n`,
    );
    writeFixtureFile(
      root,
      "src/app/layout.tsx",
      `import "@/styles/globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    );
    writeFixtureFile(
      root,
      "src/app/page.tsx",
      `import icon from "@/public/assets/images/icon.svg";
import { greeting } from "@/lib/greeting";

export default function HomePage() {
  return (
    <main>
      <h1>overlapping-alias-page</h1>
      <p data-testid="greeting">{greeting}</p>
      <img data-testid="icon" src={icon.src} alt="icon" />
    </main>
  );
}
`,
    );
  }

  it("serves a page importing through the more specific @/public/* alias", async () => {
    const root = makeTmpDir("vinext-overlapping-alias-");
    writeOverlappingAliasFixture(root);

    const { server, baseUrl } = await startFixtureServer(root, {
      appDir: path.join(root, "src"),
    });
    try {
      const { res, html } = await fetchHtml(baseUrl, "/");
      expect(res.status).toBe(200);
      expect(html).toContain("overlapping-alias-page");
      // `@/lib/greeting` resolves through the general `@/*` alias.
      expect(html).toContain("greeting-through-alias");
      // `@/public/assets/images/icon.svg` must resolve through the more
      // specific `@/public/*` alias to public/, not src/public/. Small SVGs
      // may be inlined as data URIs, so assert the img rendered with a src.
      expect(html).toMatch(/data-testid="icon" src="[^"]+"/);
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe("tsconfig aliases and CSS @import resolution", () => {
  function writeWorkspaceCssFixture(root: string): string {
    // Monorepo-ish layout modeled on create-better-t-stack scaffolds:
    //   packages/ui   — workspace package with exports-mapped CSS
    //   apps/web      — Next.js app whose tsconfig aliases @test/ui/* to the
    //                   package SOURCE dir (which does NOT contain globals.css
    //                   at the aliased location; only `exports` maps it).
    const appRoot = path.join(root, "apps", "web");
    fs.mkdirSync(appRoot, { recursive: true });
    linkRepoNodeModules(root);

    writeFixtureFile(
      root,
      "packages/ui/package.json",
      JSON.stringify({
        name: "@test/ui",
        version: "0.0.0",
        private: true,
        type: "module",
        exports: {
          "./globals.css": "./src/styles/globals.css",
        },
      }),
    );
    writeFixtureFile(
      root,
      "packages/ui/src/styles/globals.css",
      `:root { --ui-token: 1; }\nbody { margin: 0; }\n`,
    );
    writeFixtureFile(
      root,
      "packages/ui/src/components/button.tsx",
      `export function Button() {
  return <button type="button">ui-button-through-alias</button>;
}
`,
    );

    writeFixtureFile(
      appRoot,
      "package.json",
      JSON.stringify({ name: "workspace-css-web", private: true, type: "module" }),
    );
    // Simulate the workspace install: the app resolves @test/ui as a package.
    fs.mkdirSync(path.join(appRoot, "node_modules", "@test"), { recursive: true });
    fs.symlinkSync(
      path.join(root, "packages", "ui"),
      path.join(appRoot, "node_modules", "@test", "ui"),
      "dir",
    );
    writeFixtureFile(
      appRoot,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          paths: {
            "@/*": ["./src/*"],
            "@test/ui/*": ["../../packages/ui/src/*"],
          },
        },
      }),
    );
    // The CSS @import uses the bare package specifier. Next.js resolves it
    // through the package `exports` map; the tsconfig alias must not rewrite
    // it to packages/ui/src/globals.css (which does not exist).
    writeFixtureFile(
      appRoot,
      "src/index.css",
      `@import "@test/ui/globals.css";\n.web-local { color: red; }\n`,
    );
    writeFixtureFile(
      appRoot,
      "src/app/layout.tsx",
      `import "../index.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    );
    // JS/TS imports keep resolving through the tsconfig alias — including
    // subpaths that the package `exports` map does not expose.
    writeFixtureFile(
      appRoot,
      "src/app/page.tsx",
      `import { Button } from "@test/ui/components/button";

export default function HomePage() {
  return (
    <main>
      <h1>workspace-css-page</h1>
      <Button />
    </main>
  );
}
`,
    );
    return appRoot;
  }

  it("dev: resolves an exports-mapped CSS @import despite a conflicting alias", async () => {
    const root = makeTmpDir("vinext-workspace-css-dev-");
    const appRoot = writeWorkspaceCssFixture(root);

    const { server, baseUrl } = await startFixtureServer(appRoot, {
      appDir: path.join(appRoot, "src"),
    });
    try {
      const { res, html } = await fetchHtml(baseUrl, "/");
      expect(res.status).toBe(200);
      expect(html).toContain("workspace-css-page");
      expect(html).toContain("ui-button-through-alias");
    } finally {
      await server.close();
    }
  }, 60_000);

  it("build: completes with an exports-mapped CSS @import and a conflicting alias", async () => {
    const root = makeTmpDir("vinext-workspace-css-build-");
    const appRoot = writeWorkspaceCssFixture(root);

    const builder = await createBuilder({
      root: appRoot,
      configFile: false,
      plugins: [vinext({ appDir: path.join(appRoot, "src") })],
      logLevel: "silent",
    });
    await builder.buildApp();

    expect(fs.existsSync(path.join(appRoot, "dist", "server", "index.js"))).toBe(true);
  }, 120_000);
});
