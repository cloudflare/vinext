/**
 * Tests for the vinext:optimize-imports plugin and barrel export map helpers.
 *
 * Uses a pre-populated barrel export map cache so no real packages need to be
 * installed. Each test uses a unique fake entry path to avoid cache collisions.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vinext, { _buildBarrelExportMap } from "../packages/vinext/src/index.js";
import type { Plugin } from "vite";

// ── Helpers ───────────────────────────────────────────────────

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

/** Extract the vinext:optimize-imports plugin from the plugin array */
function getOptimizeImportsPlugin(): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:optimize-imports");
  if (!plugin) throw new Error("vinext:optimize-imports plugin not found");
  return plugin;
}

let testId = 0;
/** Generate a unique fake entry path to avoid cache collisions between tests */
function uniquePath(name: string): string {
  return `/fake/${name}-${++testId}/entry.js`;
}

// ── Plugin existence ─────────────────────────────────────────

describe("vinext:optimize-imports plugin", () => {
  it("exists in the plugin array", () => {
    const plugin = getOptimizeImportsPlugin();
    expect(plugin.name).toBe("vinext:optimize-imports");
    // No enforce — runs after JSX transform so parseAst gets plain JS
    expect(plugin.enforce).toBeUndefined();
  });

  // ── Guard clauses ────────────────────────────────────────────

  it("returns null for virtual modules", () => {
    const plugin = getOptimizeImportsPlugin();
    const transform = unwrapHook(plugin.transform)!;
    const code = `import { Slot } from "radix-ui";`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = (transform as any).call(plugin, code, "\0virtual:something");
    expect(result).toBeNull();
  });

  it("returns null for files without barrel imports", () => {
    const plugin = getOptimizeImportsPlugin();
    const transform = unwrapHook(plugin.transform)!;
    const code = `import React from 'react';\nconst x = 1;`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = (transform as any).call(plugin, code, "/app/page.tsx");
    expect(result).toBeNull();
  });

  it("returns null when barrel package mentioned but no resolvable entry", () => {
    const plugin = getOptimizeImportsPlugin();
    const transform = unwrapHook(plugin.transform)!;
    // "radix-ui" is in DEFAULT_OPTIMIZE_PACKAGES but since we're not in a real
    // project, resolvePackageEntry will return null → buildBarrelExportMap returns null
    const code = `import { Slot } from "radix-ui";`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = (transform as any).call(plugin, code, "/app/page.tsx");
    expect(result).toBeNull();
  });
});

// ── buildBarrelExportMap ────────────────────────────────────────

describe("buildBarrelExportMap", () => {
  it("handles export * as Name from 'sub-pkg'", () => {
    const entryPath = uniquePath("namespace-reexport");
    const barrelCode = `export * as Slot from "@radix-ui/react-slot";
export * as Tooltip from "@radix-ui/react-tooltip";`;

    const map = _buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => barrelCode,
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

  it("handles export { A, B } from 'sub-pkg'", () => {
    const entryPath = uniquePath("named-reexport");
    const barrelCode = `export { Button, buttonVariants } from "./button";
export { Input } from "./input";`;

    const map = _buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => barrelCode,
    );

    expect(map).not.toBeNull();
    expect(map!.get("Button")).toEqual({
      source: "./button",
      isNamespace: false,
      originalName: "Button",
    });
    expect(map!.get("buttonVariants")).toEqual({
      source: "./button",
      isNamespace: false,
      originalName: "buttonVariants",
    });
    expect(map!.get("Input")).toEqual({
      source: "./input",
      isNamespace: false,
      originalName: "Input",
    });
  });

  it("handles export { default as Name } from 'sub-pkg'", () => {
    const entryPath = uniquePath("default-reexport");
    const barrelCode = `export { default as Calendar } from "./calendar";`;

    const map = _buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => barrelCode,
    );

    expect(map).not.toBeNull();
    expect(map!.get("Calendar")).toEqual({
      source: "./calendar",
      isNamespace: false,
      originalName: "default",
    });
  });

  it("handles import * as X; export { X }", () => {
    const entryPath = uniquePath("import-ns-reexport");
    const barrelCode = `import * as AlertDialog from "@radix-ui/react-alert-dialog";
export { AlertDialog };`;

    const map = _buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => barrelCode,
    );

    expect(map).not.toBeNull();
    expect(map!.get("AlertDialog")).toEqual({
      source: "@radix-ui/react-alert-dialog",
      isNamespace: true,
    });
  });

  it("handles import { X }; export { X }", () => {
    const entryPath = uniquePath("import-named-reexport");
    const barrelCode = `import { format } from "date-fns/format";
export { format };`;

    const map = _buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => barrelCode,
    );

    expect(map).not.toBeNull();
    expect(map!.get("format")).toEqual({
      source: "date-fns/format",
      isNamespace: false,
      originalName: "format",
    });
  });

  it("returns null when entry cannot be resolved", () => {
    const map = _buildBarrelExportMap(
      "nonexistent-pkg",
      () => null,
      () => null,
    );
    expect(map).toBeNull();
  });

  it("returns null when entry file cannot be read", () => {
    const entryPath = uniquePath("unreadable");
    const map = _buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => null,
    );
    expect(map).toBeNull();
  });

  it("returns null when entry file has syntax errors", () => {
    const entryPath = uniquePath("syntax-error");
    const map = _buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => "export { unclosed",
    );
    expect(map).toBeNull();
  });

  it("does not resolve wildcard export * from 'sub-pkg'", () => {
    const entryPath = uniquePath("wildcard");
    const barrelCode = `export * from "./utils";
export { Button } from "./button";`;

    const map = _buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => barrelCode,
    );

    expect(map).not.toBeNull();
    // Only Button is in the map, not anything from ./utils
    expect(map!.size).toBe(1);
    expect(map!.has("Button")).toBe(true);
  });
});

// ── Plugin transform with real FS fixture ─────────────────────
//
// To exercise actual import rewriting (MagicString output), we create a minimal
// fake barrel package in a tmp node_modules directory, wire the plugin up via
// its `config` + `buildStart` hooks, and call the transform handler directly.

describe("vinext:optimize-imports transform", () => {
  let tmpDir: string;

  function getAllPlugins(): Plugin[] {
    return (vinext() as Plugin[]).flat(10) as Plugin[];
  }

  /**
   * Set up a fake barrel package in a tmp project root, initialize the plugin,
   * and return the transform handler ready to call.
   */
  async function setupTransform(
    packageName: string,
    barrelContents: string,
  ): Promise<(code: string, id: string) => ReturnType<(...args: any[]) => any>> {
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

    const plugins = getAllPlugins();
    const configPlugin = plugins.find((p) => p.name === "vinext:config");
    const optimizePlugin = plugins.find((p) => p.name === "vinext:optimize-imports");
    if (!configPlugin || !optimizePlugin) throw new Error("required plugin not found");

    // Wire up root via the config hook
    const configHook = unwrapHook(configPlugin.config);
    if (configHook)
      await configHook.call(
        configPlugin,
        { root: tmpDir },
        { command: "serve", mode: "development" },
      );

    // Initialize optimizedPackages via buildStart
    const buildStartHook = unwrapHook(optimizePlugin.buildStart);
    if (buildStartHook) await buildStartHook.call(optimizePlugin);

    const transform = unwrapHook(optimizePlugin.transform)!;
    // Return a caller that fakes the environment context as RSC (server)
    return (code: string, id: string) =>
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      (transform as any).call({ ...optimizePlugin, environment: { name: "rsc" } }, code, id);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites namespace re-export: import { Slot } from 'pkg' → import * as Slot from 'sub-pkg'", async () => {
    // lucide-react is in DEFAULT_OPTIMIZE_PACKAGES. The barrel contents below use
    // @radix-ui sub-packages intentionally — this tests the namespace rewrite path
    // with an arbitrary barrel; the package name just needs to be in the optimized list.
    const call = await setupTransform(
      "lucide-react",
      `export * as Slot from "@radix-ui/react-slot";\nexport * as Dialog from "@radix-ui/react-dialog";`,
    );
    const code = `import { Slot, Dialog } from "lucide-react";\nconst x = Slot;`;
    const result = call(code, "/app/component.tsx");
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
    const result = call(code, "/app/page.tsx");
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
    const result = call(code, "/app/page.tsx");
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
    const result = call(code, "/app/page.tsx");
    expect(result).toBeNull();
  });

  it("skips transform on client environment", async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    const plugins = getAllPlugins();
    const optimizePlugin = plugins.find((p) => p.name === "vinext:optimize-imports")!;
    const transform = unwrapHook(optimizePlugin.transform)!;
    // lucide-react is in DEFAULT_OPTIMIZE_PACKAGES — use it to hit the env guard
    const code = `import { Sun } from "lucide-react";`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = (transform as any).call(
      { ...optimizePlugin, environment: { name: "client" } },
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
    const result = call(code, "/app/page.tsx");
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
    const result = call(code, "/app/page.tsx");
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
    const result = call(code, "/app/page.tsx");
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
    const result = call(code, "/app/page.tsx");
    expect(result).not.toBeNull();

    const absFoo = path.resolve(path.join(tmpDir, "node_modules", "ramda"), "foo");
    // Must emit a default import to the sub-module, not a named import
    expect(result!.code).toContain(`import MyFoo from ${JSON.stringify(absFoo)}`);
    expect(result!.code).not.toContain(`from "ramda"`);
    // Must not contain named import syntax for the default specifier
    expect(result!.code).not.toContain("{ MyFoo }");
  });
});
