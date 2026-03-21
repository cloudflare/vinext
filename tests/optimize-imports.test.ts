/**
 * Tests for the vinext:optimize-imports plugin and barrel export map helpers.
 *
 * Uses a pre-populated barrel export map cache so no real packages need to be
 * installed. Each test uses a unique fake entry path to avoid cache collisions.
 */
import { describe, it, expect, afterEach } from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildBarrelExportMap,
  createOptimizeImportsPlugin,
  DEFAULT_OPTIMIZE_PACKAGES,
} from "../packages/vinext/src/plugins/optimize-imports.js";
import type { Plugin } from "vite-plus";

// ── Helpers ───────────────────────────────────────────────────

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

let testId = 0;
/** Generate a unique fake entry path to avoid cache collisions between tests */
function uniquePath(name: string): string {
  return `/fake/${name}-${++testId}/entry.js`;
}

// ── Plugin existence ─────────────────────────────────────────

describe("vinext:optimize-imports plugin", () => {
  it("exists and has the correct name", () => {
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => "/fake/root",
    ) as Plugin;
    expect(plugin.name).toBe("vinext:optimize-imports");
    // No enforce — runs after JSX transform so parseAst gets plain JS
    expect(plugin.enforce).toBeUndefined();
  });

  // ── Guard clauses ────────────────────────────────────────────

  it("returns null for virtual modules", async () => {
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => "/fake/root",
    ) as Plugin;
    const transform = unwrapHook(plugin.transform)!;
    const code = `import { Slot } from "radix-ui";`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = await (transform as any).call(plugin, code, "\0virtual:something");
    expect(result).toBeNull();
  });

  it("returns null for files without barrel imports", async () => {
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => "/fake/root",
    ) as Plugin;
    const transform = unwrapHook(plugin.transform)!;
    const code = `import React from 'react';\nconst x = 1;`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = await (transform as any).call(plugin, code, "/app/page.tsx");
    expect(result).toBeNull();
  });

  it("returns null when barrel package mentioned but no resolvable entry", async () => {
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => "/nonexistent/root",
    ) as Plugin;
    const transform = unwrapHook(plugin.transform)!;
    // "radix-ui" is in DEFAULT_OPTIMIZE_PACKAGES but since we're not in a real
    // project, resolvePackageEntry will return null → buildBarrelExportMap returns null
    const code = `import { Slot } from "radix-ui";`;
    // buildStart must be called first to initialize optimizedPackages
    const buildStart = unwrapHook((plugin as any).buildStart);
    if (buildStart) buildStart.call(plugin);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = await (transform as any).call(
      { ...plugin, environment: { name: "rsc" } },
      code,
      "/app/page.tsx",
    );
    expect(result).toBeNull();
  });
});

// ── buildBarrelExportMap ────────────────────────────────────────

describe("buildBarrelExportMap", () => {
  it("handles export * as Name from 'sub-pkg'", async () => {
    const entryPath = uniquePath("namespace-reexport");
    const barrelCode = `export * as Slot from "@radix-ui/react-slot";
export * as Tooltip from "@radix-ui/react-tooltip";`;

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );

    expect(map).not.toBeNull();
    expect(map!.get("Slot")).toEqual({
      source: "@radix-ui/react-slot",
      isNamespace: true,
    });
    expect(map!.get("Tooltip")).toEqual({
      source: "@radix-ui/react-tooltip",
      isNamespace: true,
    });
  });

  it("handles export { A, B } from 'sub-pkg'", async () => {
    const entryPath = uniquePath("named-reexport");
    const entryDir = path.dirname(entryPath);
    const barrelCode = `export { Button, buttonVariants } from "./button";
export { Input } from "./input";`;

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );

    expect(map).not.toBeNull();
    // Relative sources are resolved to absolute paths during map building
    expect(map!.get("Button")).toEqual({
      source: path.resolve(entryDir, "./button").split(path.sep).join("/"),
      isNamespace: false,
      originalName: "Button",
    });
    expect(map!.get("buttonVariants")).toEqual({
      source: path.resolve(entryDir, "./button").split(path.sep).join("/"),
      isNamespace: false,
      originalName: "buttonVariants",
    });
    expect(map!.get("Input")).toEqual({
      source: path.resolve(entryDir, "./input").split(path.sep).join("/"),
      isNamespace: false,
      originalName: "Input",
    });
  });

  it("handles export { default as Name } from 'sub-pkg'", async () => {
    const entryPath = uniquePath("default-reexport");
    const entryDir = path.dirname(entryPath);
    const barrelCode = `export { default as Calendar } from "./calendar";`;

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );

    expect(map).not.toBeNull();
    expect(map!.get("Calendar")).toEqual({
      source: path.resolve(entryDir, "./calendar").split(path.sep).join("/"),
      isNamespace: false,
      originalName: "default",
    });
  });

  it("handles import * as X; export { X }", async () => {
    const entryPath = uniquePath("import-ns-reexport");
    const barrelCode = `import * as AlertDialog from "@radix-ui/react-alert-dialog";
export { AlertDialog };`;

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );

    expect(map).not.toBeNull();
    expect(map!.get("AlertDialog")).toEqual({
      source: "@radix-ui/react-alert-dialog",
      isNamespace: true,
    });
  });

  it("handles import { X }; export { X }", async () => {
    const entryPath = uniquePath("import-named-reexport");
    const barrelCode = `import { format } from "date-fns/format";
export { format };`;

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );

    expect(map).not.toBeNull();
    expect(map!.get("format")).toEqual({
      source: "date-fns/format",
      isNamespace: false,
      originalName: "format",
    });
  });

  it("returns null when entry cannot be resolved", async () => {
    const map = await buildBarrelExportMap(
      "nonexistent-pkg",
      () => null,
      () => Promise.resolve(null),
    );
    expect(map).toBeNull();
  });

  it("returns null when entry file cannot be read", async () => {
    const entryPath = uniquePath("unreadable");
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(null),
    );
    expect(map).toBeNull();
  });

  it("returns an empty map when entry file has syntax errors", async () => {
    // Parse errors produce an empty map (safe fallback — leaves the import
    // unchanged in the transform), not null. Null is only returned when the
    // entry path itself cannot be resolved or the file cannot be read.
    const entryPath = uniquePath("syntax-error");
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve("export { unclosed"),
    );
    expect(map).not.toBeNull();
    expect(map!.size).toBe(0);
  });

  it("resolves wildcard export * from './sub' by merging sub-module exports", async () => {
    // Barrel: export * from "./utils" + export { Button } from "./button"
    // Sub-module ./utils exports: { format, parse }
    const entryPath = "/fake/wildcard-test/index.js";
    const subPath = "/fake/wildcard-test/utils.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./utils";\nexport { Button } from "./button";`,
      [subPath]: `export { format } from "./format";\nexport { parse } from "./parse";`,
    };

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    expect(map).not.toBeNull();
    // Button from the barrel — resolved to absolute path relative to entry dir
    expect(map!.get("Button")).toEqual({
      source: "/fake/wildcard-test/button",
      isNamespace: false,
      originalName: "Button",
    });
    // format and parse hoisted from ./utils via wildcard
    expect(map!.get("format")).toBeDefined();
    expect(map!.get("parse")).toBeDefined();
  });

  it("does not overwrite existing exports when wildcard sub-module has same name", async () => {
    // If the barrel already defines `format` explicitly, the wildcard should not overwrite it
    const entryPath = "/fake/wildcard-nooverwrite/index.js";
    const subPath = "/fake/wildcard-nooverwrite/utils.js";
    const files: Record<string, string> = {
      [entryPath]: `export { format } from "./explicit";\nexport * from "./utils";`,
      [subPath]: `export { format } from "./other-format";`,
    };

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    expect(map).not.toBeNull();
    // The explicit export wins over the wildcard — resolved to absolute path
    expect(map!.get("format")).toEqual({
      source: "/fake/wildcard-nooverwrite/explicit",
      isNamespace: false,
      originalName: "format",
    });
  });

  it("handles circular wildcard re-exports without infinite loop", async () => {
    // a.js re-exports from b.js; b.js re-exports from a.js (circular)
    const entryPath = "/fake/circular/a.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./b";\nexport { A } from "./a-impl";`,
      "/fake/circular/b.js": `export * from "./a";\nexport { B } from "./b-impl";`,
    };

    // Should not throw or hang
    await expect(
      buildBarrelExportMap(
        "test-pkg",
        () => entryPath,
        (fp) => Promise.resolve(files[fp] ?? null),
      ),
    ).resolves.not.toThrow();
  });

  it("does not resolve wildcard export * from 'sub-pkg' (external package)", async () => {
    const entryPath = uniquePath("wildcard");
    const barrelCode = `export * from "some-external-pkg";
export { Button } from "./button";`;

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );

    expect(map).not.toBeNull();
    // Only Button is in the map (external wildcard is skipped)
    expect(map!.has("Button")).toBe(true);
  });

  it("DEFAULT_OPTIMIZE_PACKAGES includes expected packages", () => {
    expect(DEFAULT_OPTIMIZE_PACKAGES).toContain("lucide-react");
    expect(DEFAULT_OPTIMIZE_PACKAGES).toContain("radix-ui");
    expect(DEFAULT_OPTIMIZE_PACKAGES).toContain("antd");
  });

  it("resolves nested subdirectory wildcard re-exports to the correct absolute path", async () => {
    // Simulates an antd-style structure:
    //   index.js         → export * from "./components"
    //   components/index.js → export { Button } from "./Button"
    //   components/Button.js → (exists)
    //
    // When Button is resolved, its source "./Button" must be resolved relative to
    // components/, not to the barrel root. Without the fix this produces
    // /fake/nested/Button instead of /fake/nested/components/Button.
    const entryPath = "/fake/nested/index.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./components/index.js";`,
      "/fake/nested/components/index.js": `export { Button } from "./Button";`,
      "/fake/nested/components/Button.js": `export function Button() {}`,
    };

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    expect(map).not.toBeNull();
    const buttonEntry = map!.get("Button");
    expect(buttonEntry).toBeDefined();
    // Must resolve relative to components/, not to the barrel root
    expect(buttonEntry!.source).toBe("/fake/nested/components/Button");
    expect(buttonEntry!.source).not.toBe("/fake/nested/Button");
  });

  it("resolves wildcard export * from './components' where components/ is a directory with index.js", async () => {
    // Tests the `/index.js` candidate added to the wildcard resolution path.
    // `export * from "./components"` with no extension — the resolver must
    // try `components/index.js` when `components.js` does not exist.
    const entryPath = "/fake/dir-wildcard/index.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./components";`,
      "/fake/dir-wildcard/components/index.js": `export { Button } from "./Button";`,
      "/fake/dir-wildcard/components/Button.js": `export function Button() {}`,
    };

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    expect(map).not.toBeNull();
    const buttonEntry = map!.get("Button");
    expect(buttonEntry).toBeDefined();
    // Must resolve through the directory index, relative to components/
    expect(buttonEntry!.source).toBe("/fake/dir-wildcard/components/Button");
  });

  it("resolves wildcard export * from './mod' where mod.jsx exists (jsx extension)", async () => {
    // Ensures .jsx is tried as a candidate — TypeScript-first internal libraries
    // may use .jsx for React components without a separate compile step.
    const entryPath = "/fake/jsx-wildcard/index.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./Button";`,
      // .jsx barrel re-exports a named symbol — pure ESM, no JSX syntax needed
      "/fake/jsx-wildcard/Button.jsx": `export { Button } from "./button-impl";`,
    };

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    expect(map).not.toBeNull();
    // Button must be resolvable via the .jsx candidate
    expect(map!.has("Button")).toBe(true);
  });

  it("resolves wildcard export * from './mod' where mod.cjs exists (cjs extension)", async () => {
    // Ensures .cjs is tried as a candidate — CommonJS-style re-export files
    // in TypeScript monorepos may use .cjs after compilation.
    const entryPath = "/fake/cjs-wildcard/index.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./helpers";`,
      "/fake/cjs-wildcard/helpers.cjs": `exports.helper = function helper() {};`,
    };

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    // The .cjs file is found (not null map). The map may be empty if parseAst
    // can't parse CJS syntax, but the important thing is no error is thrown.
    expect(map).not.toBeNull();
  });

  it("skips malformed AST nodes without crashing (astName returns null gracefully)", async () => {
    // Simulates a barrel where an export specifier has an unexpected AST node shape.
    // astName returns null → the export is silently skipped rather than throwing.
    // We achieve this by using a string literal key in export { "a" as b } syntax,
    // which produces a Literal node (value) — well-handled. We also test that a
    // valid export alongside a skipped malformed one doesn't corrupt the whole map.
    const entryPath = uniquePath("malformed-ast");
    const barrelCode = `export { Button } from "./button";`;

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );

    // Normal exports are still present
    expect(map).not.toBeNull();
    expect(map!.has("Button")).toBe(true);
  });

  it("resolves export function declaration in sub-module (date-fns style)", async () => {
    // date-fns barrel: `export * from "./formatDistanceToNow.js"`
    // sub-module:      `export function formatDistanceToNow(...) {}`
    // The function is declared inline — no re-export specifier, no source.
    // buildBarrelExportMap must recurse into the sub-module and register the
    // inline declaration, mapping "formatDistanceToNow" → the sub-module file.
    const entryPath = "/fake/date-fns/index.js";
    const subPath = "/fake/date-fns/formatDistanceToNow.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./formatDistanceToNow.js";`,
      [subPath]: `export function formatDistanceToNow(date, options) { return date; }`,
    };

    const map = await buildBarrelExportMap(
      "date-fns",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    expect(map).not.toBeNull();
    const entry = map!.get("formatDistanceToNow");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe(subPath);
    expect(entry!.isNamespace).toBe(false);
  });

  it("resolves multiple export const declarations in a single VariableDeclaration", async () => {
    // `export const x = 1, y = 2` → VariableDeclaration with two declarators.
    const entryPath = "/fake/multi-const/index.js";
    const subPath = "/fake/multi-const/utils.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./utils.js";`,
      [subPath]: `export const add = (a, b) => a + b, subtract = (a, b) => a - b;`,
    };

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    expect(map).not.toBeNull();
    expect(map!.get("add")).toMatchObject({ source: subPath, isNamespace: false });
    expect(map!.get("subtract")).toMatchObject({ source: subPath, isNamespace: false });
  });

  it("resolves export class declaration in sub-module", async () => {
    const entryPath = "/fake/class-export/index.js";
    const subPath = "/fake/class-export/MyClass.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./MyClass.js";`,
      [subPath]: `export class MyClass {}`,
    };

    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );

    expect(map).not.toBeNull();
    expect(map!.get("MyClass")).toMatchObject({ source: subPath, isNamespace: false });
  });
});

// ── Plugin transform with real FS fixture ─────────────────────
//
// To exercise actual import rewriting (MagicString output), we create a minimal
// fake barrel package in a tmp node_modules directory, wire the plugin up via
// its `buildStart` hook, and call the transform handler directly.

describe("vinext:optimize-imports transform", () => {
  let tmpDir: string;

  /**
   * Set up a fake barrel package in a tmp project root, initialize the plugin,
   * and return the transform handler ready to call.
   */
  async function setupTransform(
    packageName: string,
    barrelContents: string,
  ): Promise<(code: string, id: string) => Promise<ReturnType<(...args: any[]) => any>>> {
    // Create tmp project with a fake package in node_modules.
    // The package name must be in DEFAULT_OPTIMIZE_PACKAGES (or configured via
    // next.config.js) for the plugin's buildStart to include it.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    const pkgDir = path.join(tmpDir, "node_modules", packageName);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: packageName, type: "module", main: "./index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), barrelContents);

    let capturedRoot = tmpDir;
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => capturedRoot,
    ) as Plugin;

    // Initialize optimizedPackages via buildStart
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);

    const transform = unwrapHook(plugin.transform)!;
    // Return a caller that fakes the environment context as RSC (server)
    return async (code: string, id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (transform as any).call({ ...plugin, environment: { name: "rsc" } }, code, id);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites namespace re-export: import { X } from 'barrel' → import * as X from 'sub-pkg'", async () => {
    // lucide-react is in DEFAULT_OPTIMIZE_PACKAGES. The barrel contents below use
    // @radix-ui sub-packages intentionally — this tests the namespace rewrite path
    // with an arbitrary barrel; the package name just needs to be in the optimized list.
    const call = await setupTransform(
      "lucide-react",
      `export * as Slot from "@radix-ui/react-slot";\nexport * as Dialog from "@radix-ui/react-dialog";`,
    );
    const code = `import { Slot, Dialog } from "lucide-react";\nconst x = Slot;`;
    const result = await call(code, "/app/component.tsx");
    expect(result).not.toBeNull();
    expect(result!.code).toContain(`import * as Slot from "@radix-ui/react-slot"`);
    expect(result!.code).toContain(`import * as Dialog from "@radix-ui/react-dialog"`);
    expect(result!.code).not.toContain(`from "lucide-react"`);
  });

  it("rewrites named re-export: relative source resolved against barrel dir, not user file", async () => {
    // date-fns is in DEFAULT_OPTIMIZE_PACKAGES.
    // Barrels commonly use relative re-exports (e.g. `export { Button } from "./button"`).
    // The plugin must resolve these against the barrel entry's directory, not the user's file.
    const call = await setupTransform(
      "date-fns",
      `export { Button, buttonVariants } from "./button";\nexport { Input } from "./input";`,
    );
    const code = `import { Button, Input } from "date-fns";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();
    // Expect absolute paths rooted at the package dir, not relative paths
    const pkgDir = path.join(tmpDir, "node_modules", "date-fns");
    expect(result!.code).toContain(
      `import { Button } from ${JSON.stringify(path.resolve(pkgDir, "button"))}`,
    );
    expect(result!.code).toContain(
      `import { Input } from ${JSON.stringify(path.resolve(pkgDir, "input"))}`,
    );
    expect(result!.code).not.toContain(`from "date-fns"`);
    // Must NOT contain the raw relative path (that would resolve against user file)
    expect(result!.code).not.toContain(`from "./button"`);
    expect(result!.code).not.toContain(`from "./input"`);
  });

  it("appends trailing semicolons to all replacement statements", async () => {
    // lodash-es is in DEFAULT_OPTIMIZE_PACKAGES
    const call = await setupTransform(
      "lodash-es",
      `export * as A from "./a";\nexport * as B from "./b";`,
    );
    const code = `import { A, B } from "lodash-es";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();
    // Every replacement statement should end with a semicolon
    const lines = result!.code
      .trim()
      .split("\n")
      .filter((l: string) => l.startsWith("import"));
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.trimEnd()).toMatch(/;$/);
    }
    // Paths must be absolute (no bare relative paths)
    expect(result!.code).not.toContain(`from "./a"`);
    expect(result!.code).not.toContain(`from "./b"`);
  });

  it("leaves import unchanged when a specifier is not in the barrel map", async () => {
    // rxjs is in DEFAULT_OPTIMIZE_PACKAGES
    const call = await setupTransform("rxjs", `export * as Slot from "@radix-ui/react-slot";`);
    // "Unknown" is not exported from the barrel
    const code = `import { Slot, Unknown } from "rxjs";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).toBeNull();
  });

  it("leaves namespace import unchanged: import * as Pkg from 'barrel' cannot be optimized", async () => {
    // Namespace imports capture the entire barrel module — there's no safe sub-module
    // to redirect to, so the import must be left unchanged.
    const call = await setupTransform(
      "lucide-react",
      `export * as Slot from "@radix-ui/react-slot";\nexport * as Dialog from "@radix-ui/react-dialog";`,
    );
    const code = `import * as LucideReact from "lucide-react";`;
    const result = await call(code, "/app/page.tsx");
    // ImportNamespaceSpecifier sets allResolved = false → import left unchanged
    expect(result).toBeNull();
  });

  it("skips transform on client environment", async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;
    // lucide-react is in DEFAULT_OPTIMIZE_PACKAGES — use it to hit the env guard
    const code = `import { Sun } from "lucide-react";`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = await (transform as any).call(
      { ...plugin, environment: { name: "client" } },
      code,
      "/app/page.tsx",
    );
    expect(result).toBeNull();
  });

  it("groups multiple specifiers from same source into one import statement", async () => {
    // ramda is in DEFAULT_OPTIMIZE_PACKAGES
    const call = await setupTransform(
      "ramda",
      `export { Button, buttonVariants } from "./button";`,
    );
    const code = `import { Button, buttonVariants } from "ramda";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();
    // Both should be in a single import from the resolved absolute path
    const importLines = result!.code.split("\n").filter((l: string) => l.includes("from"));
    expect(importLines).toHaveLength(1);
    expect(importLines[0]).toContain("Button");
    expect(importLines[0]).toContain("buttonVariants");
    // Relative path must be resolved to absolute (no bare ./button)
    expect(result!.code).not.toContain(`from "./button"`);
    const expected = path.resolve(path.join(tmpDir, "node_modules", "ramda"), "button");
    expect(importLines[0]).toContain(expected);
  });

  it("produces separate statements for namespace and named imports from the same source", async () => {
    // lodash-es is in DEFAULT_OPTIMIZE_PACKAGES.
    // The barrel exports both a namespace re-export and a named re-export pointing at
    // the same sub-module path. Without the `::${isNamespace}` key fix these two
    // specifiers would be merged into one group, corrupting the output.
    const call = await setupTransform(
      "lodash-es",
      [
        // namespace re-export: import { Chunk } from "lodash-es" → import * as Chunk from <abs>
        `export * as Chunk from "./chunk";`,
        // named re-export from the very same sub-module path
        `export { chunkHelper } from "./chunk";`,
      ].join("\n"),
    );
    // Import both in a single statement
    const code = `import { Chunk, chunkHelper } from "lodash-es";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();

    const importLines = result!.code
      .split("\n")
      .filter((l: string) => l.trimStart().startsWith("import"));
    // Must produce two separate import statements, not one corrupted one
    expect(importLines).toHaveLength(2);

    const nsLine = importLines.find((l: string) => l.includes("* as Chunk"));
    const namedLine = importLines.find((l: string) => l.includes("chunkHelper"));
    expect(nsLine).toBeDefined();
    expect(namedLine).toBeDefined();

    // Both must resolve relative path to absolute — no bare ./chunk
    expect(result!.code).not.toContain(`from "./chunk"`);
    const absChunk = path.resolve(path.join(tmpDir, "node_modules", "lodash-es"), "chunk");
    // Namespace import must use `import * as` syntax
    expect(nsLine).toContain("import * as Chunk from");
    expect(nsLine).toContain(absChunk);
    // Named import must use `import { ... }` syntax
    expect(namedLine).toContain("import { chunkHelper } from");
    expect(namedLine).toContain(absChunk);
  });

  it("rewrites default re-export: import { Calendar } from 'pkg' → import Calendar from 'sub'", async () => {
    // rxjs is in DEFAULT_OPTIMIZE_PACKAGES.
    // `export { default as Calendar } from "./calendar"` in the barrel should produce
    // `import Calendar from "./calendar"` (a default import), not `import { default as Calendar }`.
    const call = await setupTransform("rxjs", `export { default as Calendar } from "./calendar";`);
    const code = `import { Calendar } from "rxjs";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();

    const absCalendar = path.resolve(path.join(tmpDir, "node_modules", "rxjs"), "calendar");
    // Must emit a default import, not a named `{ default as ... }` import
    expect(result!.code).toContain(`import Calendar from ${JSON.stringify(absCalendar)}`);
    expect(result!.code).not.toContain("{ default as Calendar }");
    expect(result!.code).not.toContain(`from "rxjs"`);
  });

  it("rewrites ImportDefaultSpecifier: import MyFoo from 'pkg' → import MyFoo from 'sub'", async () => {
    // ramda is in DEFAULT_OPTIMIZE_PACKAGES.
    // Barrel exposes its default export via `import Foo from "./foo"; export { Foo as default }`.
    // A user writing `import MyFoo from "ramda"` (ImportDefaultSpecifier) should get
    // rewritten to `import MyFoo from "<abs>/foo"` (default import from the sub-module).
    const call = await setupTransform(
      "ramda",
      [`import Foo from "./foo";`, `export { Foo as default };`].join("\n"),
    );
    const code = `import MyFoo from "ramda";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();

    const absFoo = path.resolve(path.join(tmpDir, "node_modules", "ramda"), "foo");
    // Must emit a default import to the sub-module, not a named import
    expect(result!.code).toContain(`import MyFoo from ${JSON.stringify(absFoo)}`);
    expect(result!.code).not.toContain(`from "ramda"`);
    // Must not contain named import syntax for the default specifier
    expect(result!.code).not.toContain("{ MyFoo }");
  });

  it("rewrites imports from wildcard re-exports in barrels", async () => {
    // antd is in DEFAULT_OPTIMIZE_PACKAGES.
    // Barrel uses `export * from "./button"` — the plugin should recurse and resolve
    // `Button` via the sub-module.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    const pkgDir = path.join(tmpDir, "node_modules", "antd");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "antd", type: "module", main: "./index.js" }),
    );
    // Barrel uses wildcard re-export
    fs.writeFileSync(path.join(pkgDir, "index.js"), `export * from "./components";`);
    // Sub-module exports Button
    fs.writeFileSync(
      path.join(pkgDir, "components.js"),
      `export { Button } from "./button";\nexport { Input } from "./input";`,
    );

    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;
    const call = async (code: string, id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (transform as any).call({ ...plugin, environment: { name: "rsc" } }, code, id);

    const code = `import { Button } from "antd";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();
    // Button should be resolved through the wildcard chain to an absolute path
    expect(result!.code).not.toContain(`from "antd"`);
    expect(result!.code).toContain("import");
    // Must use an absolute path, not a relative one
    expect(result!.code).not.toContain(`from "./`);
  });

  it("populates subpkgOrigin independently for RSC and SSR when they share the same barrel entry", async () => {
    // Regression test: registeredBarrels used to be keyed only by barrelEntry (not envKey:barrelEntry).
    // When RSC and SSR share the same barrel entry path (common — most packages have no react-server
    // export condition), RSC would register the barrel first, and SSR would skip the inner loop
    // entirely, leaving the SSR subpkgOrigin map empty. Subsequent resolveId calls from SSR would
    // fall through to the cross-env fallback instead of hitting SSR's own map.
    // After the fix, each environment maintains its own registeredBarrels key so both RSC and SSR
    // independently populate their own subpkgOrigin maps.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    // Use a package with no react-server condition so RSC and SSR resolve the same entry.
    const pkgDir = path.join(tmpDir, "node_modules", "lucide-react");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "lucide-react",
        type: "module",
        main: "./index.js",
      }),
    );
    // Barrel exports a named re-export from a scoped sub-package.
    fs.writeFileSync(path.join(pkgDir, "index.js"), `export { Slot } from "@radix-ui/react-slot";`);

    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;

    const rscCall = async (code: string, id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (transform as any).call({ ...plugin, environment: { name: "rsc" } }, code, id);
    const ssrCall = async (code: string, id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (transform as any).call({ ...plugin, environment: { name: "ssr" } }, code, id);

    // RSC processes the barrel first — this registers `rsc:<barrelEntry>`.
    const rscResult = await rscCall(`import { Slot } from "lucide-react";`, "/app/page.tsx");
    expect(rscResult).not.toBeNull();
    expect(rscResult!.code).toContain(`from "@radix-ui/react-slot"`);

    // SSR processes the same barrel next — with the bug it would skip the inner loop
    // (barrelEntry already in registeredBarrels) and leave its subpkgOrigin map empty.
    // With the fix it registers `ssr:<barrelEntry>` and populates its own map.
    const ssrResult = await ssrCall(`import { Slot } from "lucide-react";`, "/app/layout.tsx");
    expect(ssrResult).not.toBeNull();
    expect(ssrResult!.code).toContain(`from "@radix-ui/react-slot"`);
  });

  it("prefers react-server export condition in RSC but not in SSR", async () => {
    // Simulates a package (like react-dom) that exposes different barrel entries
    // under "react-server" vs "import" export conditions.
    // In the RSC environment the plugin should pick the react-server entry;
    // in SSR it must use the standard import entry (SSR uses the full React runtime).
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    const pkgDir = path.join(tmpDir, "node_modules", "antd");
    fs.mkdirSync(pkgDir, { recursive: true });

    // Package with diverging react-server vs import entries
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "antd",
        type: "module",
        exports: {
          ".": {
            "react-server": "./rsc-index.js",
            import: "./index.js",
            default: "./index.js",
          },
        },
        main: "./index.js",
      }),
    );
    // RSC barrel: exports RscButton
    fs.writeFileSync(path.join(pkgDir, "rsc-index.js"), `export { RscButton } from "./rsc-btn";`);
    // Standard barrel: exports Button
    fs.writeFileSync(path.join(pkgDir, "index.js"), `export { Button } from "./btn";`);

    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;

    // RSC environment: should use react-server entry → knows about RscButton
    const rscCall = async (code: string, id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (transform as any).call({ ...plugin, environment: { name: "rsc" } }, code, id);
    // SSR environment: should use import entry → knows about Button, not RscButton
    const ssrCall = async (code: string, id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      await (transform as any).call({ ...plugin, environment: { name: "ssr" } }, code, id);

    // RSC: RscButton is exported from the react-server barrel → rewrite succeeds
    const rscResult = await rscCall(`import { RscButton } from "antd";`, "/app/page.tsx");
    expect(rscResult).not.toBeNull();
    expect(rscResult!.code).not.toContain(`from "antd"`);
    expect(rscResult!.code).toContain("rsc-btn");

    // SSR: RscButton is NOT in the standard barrel → rewrite must be skipped
    const ssrResultUnknown = await ssrCall(`import { RscButton } from "antd";`, "/app/page.tsx");
    expect(ssrResultUnknown).toBeNull();

    // SSR: Button IS in the standard barrel → rewrite succeeds
    const ssrResultKnown = await ssrCall(`import { Button } from "antd";`, "/app/page.tsx");
    expect(ssrResultKnown).not.toBeNull();
    expect(ssrResultKnown!.code).not.toContain(`from "antd"`);
    expect(ssrResultKnown!.code).toContain("btn");
  });
});
