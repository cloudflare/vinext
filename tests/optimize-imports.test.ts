import { describe, it, expect, afterEach } from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOptimizeImportsPlugin } from "../packages/vinext/src/plugins/optimize-imports.js";
import type { Plugin } from "vite-plus";

function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

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
  ): Promise<
    (
      code: string,
      id: string,
      envName?: "rsc" | "ssr" | "client",
    ) => Promise<ReturnType<(...args: any[]) => any>>
  > {
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

    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);

    const transform = unwrapHook(plugin.transform)!;
    return async (code: string, id: string, envName = "rsc") =>
      await (transform as any).call({ ...plugin, environment: { name: envName } }, code, id);
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites namespace re-export: import { X } from 'barrel' → import * as X from 'sub-pkg'", async () => {
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
    const call = await setupTransform(
      "date-fns",
      `export { Button, buttonVariants } from "./button";\nexport { Input } from "./input";`,
    );
    const code = `import { Button, Input } from "date-fns";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();
    const pkgDir = path.join(tmpDir, "node_modules", "date-fns");
    expect(result!.code).toContain(
      `import { Button } from ${JSON.stringify(path.resolve(pkgDir, "button"))}`,
    );
    expect(result!.code).toContain(
      `import { Input } from ${JSON.stringify(path.resolve(pkgDir, "input"))}`,
    );
    expect(result!.code).not.toContain(`from "date-fns"`);
    expect(result!.code).not.toContain(`from "./button"`);
    expect(result!.code).not.toContain(`from "./input"`);
  });

  it("appends trailing semicolons to all replacement statements", async () => {
    const call = await setupTransform(
      "lodash-es",
      `export * as A from "./a";\nexport * as B from "./b";`,
    );
    const code = `import { A, B } from "lodash-es";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();
    const lines = result!.code
      .trim()
      .split("\n")
      .filter((l: string) => l.startsWith("import"));
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.trimEnd()).toMatch(/;$/);
    }
    expect(result!.code).not.toContain(`from "./a"`);
    expect(result!.code).not.toContain(`from "./b"`);
  });

  it("leaves import unchanged when a specifier is not in the barrel map", async () => {
    const call = await setupTransform("rxjs", `export * as Slot from "@radix-ui/react-slot";`);
    const code = `import { Slot, Unknown } from "rxjs";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).toBeNull();
  });

  it("leaves namespace import unchanged: import * as Pkg from 'barrel' cannot be optimized", async () => {
    const call = await setupTransform(
      "lucide-react",
      `export * as Slot from "@radix-ui/react-slot";\nexport * as Dialog from "@radix-ui/react-dialog";`,
    );
    const code = `import * as LucideReact from "lucide-react";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).toBeNull();
  });

  it("rewrites direct barrel imports on client environment when they resolve to concrete files", async () => {
    const call = await setupTransform(
      "lucide-react",
      `export { Sun } from "./dist/esm/icons/sun.js";`,
    );
    fs.mkdirSync(path.join(tmpDir, "node_modules", "lucide-react", "dist", "esm", "icons"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "lucide-react", "dist", "esm", "icons", "sun.js"),
      `export function Sun() { return null; }`,
    );
    const code = `import { Sun } from "lucide-react";`;

    const result = await call(code, "/app/page.tsx", "client");
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain(`from "lucide-react"`);
    expect(result!.code).toContain(`/lucide-react/dist/esm/icons/sun.js`);
  });

  it("groups multiple specifiers from same source into one import statement", async () => {
    const call = await setupTransform(
      "ramda",
      `export { Button, buttonVariants } from "./button";`,
    );
    const code = `import { Button, buttonVariants } from "ramda";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();
    const importLines = result!.code.split("\n").filter((l: string) => l.includes("from"));
    expect(importLines).toHaveLength(1);
    expect(importLines[0]).toContain("Button");
    expect(importLines[0]).toContain("buttonVariants");
    expect(result!.code).not.toContain(`from "./button"`);
    const expected = path.resolve(path.join(tmpDir, "node_modules", "ramda"), "button");
    expect(importLines[0]).toContain(expected);
  });

  it("produces separate statements for namespace and named imports from the same source", async () => {
    const call = await setupTransform(
      "lodash-es",
      [`export * as Chunk from "./chunk";`, `export { chunkHelper } from "./chunk";`].join("\n"),
    );
    const code = `import { Chunk, chunkHelper } from "lodash-es";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();

    const importLines = result!.code
      .split("\n")
      .filter((l: string) => l.trimStart().startsWith("import"));
    expect(importLines).toHaveLength(2);

    const nsLine = importLines.find((l: string) => l.includes("* as Chunk"));
    const namedLine = importLines.find((l: string) => l.includes("chunkHelper"));
    expect(nsLine).toBeDefined();
    expect(namedLine).toBeDefined();

    expect(result!.code).not.toContain(`from "./chunk"`);
    const absChunk = path.resolve(path.join(tmpDir, "node_modules", "lodash-es"), "chunk");
    expect(nsLine).toContain("import * as Chunk from");
    expect(nsLine).toContain(absChunk);
    expect(namedLine).toContain("import { chunkHelper } from");
    expect(namedLine).toContain(absChunk);
  });

  it("rewrites default re-export: import { Calendar } from 'pkg' → import Calendar from 'sub'", async () => {
    const call = await setupTransform("rxjs", `export { default as Calendar } from "./calendar";`);
    const code = `import { Calendar } from "rxjs";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();

    const absCalendar = path.resolve(path.join(tmpDir, "node_modules", "rxjs"), "calendar");
    expect(result!.code).toContain(`import Calendar from ${JSON.stringify(absCalendar)}`);
    expect(result!.code).not.toContain("{ default as Calendar }");
    expect(result!.code).not.toContain(`from "rxjs"`);
  });

  it("rewrites ImportDefaultSpecifier: import MyFoo from 'pkg' → import MyFoo from 'sub'", async () => {
    const call = await setupTransform(
      "ramda",
      [`import Foo from "./foo";`, `export { Foo as default };`].join("\n"),
    );
    const code = `import MyFoo from "ramda";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();

    const absFoo = path.resolve(path.join(tmpDir, "node_modules", "ramda"), "foo");
    expect(result!.code).toContain(`import MyFoo from ${JSON.stringify(absFoo)}`);
    expect(result!.code).not.toContain(`from "ramda"`);
    expect(result!.code).not.toContain("{ MyFoo }");
  });

  it("rewrites same-file alias exports from wildcard re-exports", async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    const pkgDir = path.join(tmpDir, "node_modules", "antd");
    fs.mkdirSync(path.join(pkgDir, "components"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "antd", type: "module", main: "./index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), `export * from "./components/listbox.js";`);
    fs.writeFileSync(
      path.join(pkgDir, "components", "listbox.js"),
      `const Mo = {};\nexport { Mo as Listbox };`,
    );

    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;
    const call = async (code: string, id: string) =>
      await (transform as any).call({ ...plugin, environment: { name: "rsc" } }, code, id);

    const code = `import { Listbox as HeadlessListbox } from "antd";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();

    const absListbox = path.join(pkgDir, "components", "listbox.js");
    expect(result!.code).toContain(
      `import { Listbox as HeadlessListbox } from ${JSON.stringify(absListbox)}`,
    );
    expect(result!.code).not.toContain(`from "antd"`);
  });

  it("rewrites imports from wildcard re-exports in barrels", async () => {
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
    fs.writeFileSync(path.join(pkgDir, "index.js"), `export * from "./components";`);
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
      await (transform as any).call({ ...plugin, environment: { name: "rsc" } }, code, id);

    const code = `import { Button } from "antd";`;
    const result = await call(code, "/app/page.tsx");
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain(`from "antd"`);
    expect(result!.code).toContain("import");
    expect(result!.code).not.toContain(`from "./`);
  });

  it("populates subpkgOrigin independently for RSC and SSR when they share the same barrel entry", async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    const pkgDir = path.join(tmpDir, "node_modules", "lucide-react");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "lucide-react", type: "module", main: "./index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), `export { Slot } from "@radix-ui/react-slot";`);

    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;

    const rscCall = async (code: string, id: string) =>
      await (transform as any).call({ ...plugin, environment: { name: "rsc" } }, code, id);
    const ssrCall = async (code: string, id: string) =>
      await (transform as any).call({ ...plugin, environment: { name: "ssr" } }, code, id);

    const rscResult = await rscCall(`import { Slot } from "lucide-react";`, "/app/page.tsx");
    expect(rscResult).not.toBeNull();
    expect(rscResult!.code).toContain(`from "@radix-ui/react-slot"`);

    const ssrResult = await ssrCall(`import { Slot } from "lucide-react";`, "/app/layout.tsx");
    expect(ssrResult).not.toBeNull();
    expect(ssrResult!.code).toContain(`from "@radix-ui/react-slot"`);
  });

  it("prefers react-server export condition in RSC but not in SSR", async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );
    const pkgDir = path.join(tmpDir, "node_modules", "antd");
    fs.mkdirSync(pkgDir, { recursive: true });

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
    fs.writeFileSync(path.join(pkgDir, "rsc-index.js"), `export { RscButton } from "./rsc-btn";`);
    fs.writeFileSync(path.join(pkgDir, "index.js"), `export { Button } from "./btn";`);

    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;

    const rscCall = async (code: string, id: string) =>
      await (transform as any).call({ ...plugin, environment: { name: "rsc" } }, code, id);
    const ssrCall = async (code: string, id: string) =>
      await (transform as any).call({ ...plugin, environment: { name: "ssr" } }, code, id);

    const rscResult = await rscCall(`import { RscButton } from "antd";`, "/app/page.tsx");
    expect(rscResult).not.toBeNull();
    expect(rscResult!.code).not.toContain(`from "antd"`);
    expect(rscResult!.code).toContain("rsc-btn");

    const ssrResultUnknown = await ssrCall(`import { RscButton } from "antd";`, "/app/page.tsx");
    expect(ssrResultUnknown).toBeNull();

    const ssrResultKnown = await ssrCall(`import { Button } from "antd";`, "/app/page.tsx");
    expect(ssrResultKnown).not.toBeNull();
    expect(ssrResultKnown!.code).not.toContain(`from "antd"`);
    expect(ssrResultKnown!.code).toContain("btn");
  });
});
