import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Alias } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { collectHostEntryOptimizeDepsIncludes } from "../packages/vinext/src/plugins/host-entry-optimize-deps.js";

describe("collectHostEntryOptimizeDepsIncludes", () => {
  let root: string;
  let packageRoot: string;

  function write(relativePath: string, contents: string): string {
    const file = path.join(packageRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  }

  function install(name: string, directory = root): string {
    const dependencyRoot = path.join(directory, "node_modules", name);
    fs.mkdirSync(dependencyRoot, { recursive: true });
    fs.writeFileSync(path.join(dependencyRoot, "package.json"), JSON.stringify({ name }));
    return dependencyRoot;
  }

  function collect(entry: string, aliases: Alias[] = []): string[] {
    return collectHostEntryOptimizeDepsIncludes(entry, root, aliases).sort();
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-host-entry-deps-"));
    packageRoot = path.join(root, "node_modules", "@adapter", "platform");
    write("package.json", JSON.stringify({ name: "@adapter/platform", type: "module" }));
    for (const name of [
      "@scope/store",
      "all-lib",
      "side-effect-dep",
      "stage-lib",
      "vinext",
      "empty-specifiers",
      "mixed-specifiers",
      "real-dep",
      "inside-dep",
      "outside-dep",
      "entry-dep",
      "cycle-dep",
      "broken-dep",
      "dynamic-dep",
      "lazy-dep",
      "template-dep",
    ]) {
      install(name);
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("follows relative imports within the owning package", () => {
    // A nameless manifest (for example a dist `type` marker) must not hide the
    // real owner.
    write("dist/package.json", JSON.stringify({ type: "module" }));
    const entry = write(
      "dist/entry.worker.js",
      [
        'import "side-effect-dep";',
        'import { createStore } from "@scope/store";',
        'import { helper } from "./shared/helper.js";',
        'export { stage } from "../lib/stage.js";',
        'export * from "./all.js";',
        "export default createStore(helper);",
      ].join("\n"),
    );
    write("dist/shared/helper.js", 'import { request } from "vinext/server/request-stage";\n');
    write("lib/stage.js", 'export { stage } from "stage-lib/runtime";\n');
    write("dist/all.js", 'export * from "all-lib";\nimport { store } from "@scope/store";\n');

    expect(collect(entry)).toEqual([
      "@scope/store",
      "all-lib",
      "side-effect-dep",
      "stage-lib/runtime",
      "vinext/server/request-stage",
    ]);
  });

  it("follows dynamic imports with a static request", () => {
    const entry = write(
      "dist/entry.worker.js",
      [
        'const store = await import("dynamic-dep");',
        "export async function load(name) {",
        '  const { lazy } = await import("./lazy.js");',
        "  const template = await import(`template-dep`);",
        "  return [store, lazy, template, await import(name), await import(`${name}-dep`)];",
        "}",
      ].join("\n"),
    );
    write("dist/lazy.js", 'export const lazy = () => import("lazy-dep");\n');

    expect(collect(entry)).toEqual(["dynamic-dep", "lazy-dep", "template-dep"]);
  });

  it("skips type-only imports", () => {
    const entry = write(
      "entry.ts",
      [
        'import type { Store } from "type-only-import";',
        'import { type Options } from "type-only-specifier";',
        'export type { Env } from "type-only-export";',
        'export { type Binding } from "type-only-export-specifier";',
        'export type * from "type-only-export-all";',
        'import { type Mixed, runtime } from "mixed-specifiers";',
        'import {} from "empty-specifiers";',
        'export type Lazy = typeof import("type-only-import-type");',
        "export const value = runtime as unknown as Store & Options;",
      ].join("\n"),
    );

    expect(collect(entry)).toEqual(["empty-specifiers", "mixed-specifiers"]);
  });

  it("skips builtins, protocol and virtual ids, package imports, and self-imports", () => {
    const entry = write(
      "entry.js",
      [
        'import fs from "fs";',
        'import { readFile } from "fs/promises";',
        'import { Buffer } from "node:buffer";',
        'import { WorkerEntrypoint } from "cloudflare:workers";',
        'import options from "virtual:vinext-cdn-cache-adapter";',
        'import internal from "#internal";',
        'import self from "@adapter/platform";',
        'import selfSubpath from "@adapter/platform/runtime";',
        'import absolute from "/absolute/module.js";',
        'import real from "real-dep";',
      ].join("\n"),
    );

    expect(collect(entry)).toEqual(["real-dep"]);
  });

  it("does not follow relative imports that leave the owning package", () => {
    const outside = path.join(root, "node_modules", "other-package");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "other-package" }));
    fs.writeFileSync(path.join(outside, "index.js"), 'import "outside-dep";\n');
    const entry = write(
      "entry.js",
      'import "../../other-package/index.js";\nimport "inside-dep";\n',
    );

    expect(collect(entry)).toEqual(["inside-dep"]);
  });

  it("follows relative imports by real path", () => {
    // Vite realpaths a symlinked module and resolves its imports from the
    // target, which here is another package with its own copy.
    const targetRoot = path.join(root, "packages", "shared");
    fs.mkdirSync(path.join(targetRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, "package.json"), JSON.stringify({ name: "shared" }));
    fs.writeFileSync(path.join(targetRoot, "dist", "index.js"), 'import "target-dep";\n');
    install("target-dep");
    install("target-dep", targetRoot);
    fs.symlinkSync(path.join(targetRoot, "dist"), path.join(packageRoot, "shared"), "junction");
    const entry = write("entry.js", 'import "./shared/index.js";\nimport "inside-dep";\n');

    expect(collect(entry)).toEqual(["inside-dep"]);
  });

  it("skips ids matched by an alias", () => {
    const entry = write(
      "entry.js",
      [
        'import "real-dep";',
        'import "aliased-dep";',
        'import "aliased-dep/subpath";',
        'import "prefix-dep/runtime";',
        'import "pattern-dep";',
        'import "aliased-dep-suffix";',
      ].join("\n"),
    );
    for (const name of ["aliased-dep", "prefix-dep", "pattern-dep", "aliased-dep-suffix"]) {
      install(name);
    }

    expect(
      collect(entry, [
        { find: "aliased-dep", replacement: path.join(root, "src", "aliased-dep.ts") },
        { find: "prefix-dep/", replacement: path.join(root, "src", "prefix-dep") + "/" },
        { find: /^pattern-dep$/, replacement: path.join(root, "src", "pattern-dep.ts") },
      ]),
    ).toEqual(["aliased-dep-suffix", "real-dep"]);
  });

  it("tolerates missing files, cycles, and unparsable modules", () => {
    const entry = write(
      "entry.js",
      [
        'import "./missing.js";',
        'import "./cycle.js";',
        'import "./broken.js";',
        'import "./data.json";',
        'import "entry-dep";',
      ].join("\n"),
    );
    write("cycle.js", 'import "./entry.js";\nimport "cycle-dep";\n');
    write("broken.js", 'import "broken-dep";\nexport const = ;\n');
    write("data.json", "{}");

    expect(collect(entry)).toEqual(["cycle-dep", "entry-dep"]);
  });

  it("caps the number of visited files", () => {
    const fileCount = 100;
    for (let index = 0; index < fileCount; index++) {
      const next = index + 1 < fileCount ? `import "./file-${index + 1}.js";\n` : "";
      write(`file-${index}.js`, `${next}import "dep-${index}";\n`);
    }

    for (let index = 0; index < fileCount; index++) install(`dep-${index}`);

    const includes = collect(path.join(packageRoot, "file-0.js"));
    expect(includes).toHaveLength(64);
    expect(includes).toContain("dep-0");
    expect(includes).toContain("dep-63");
    expect(includes).not.toContain("dep-64");
  });

  it("emits root-form ids, as the optimizer discovers them", () => {
    // The adapter's own copy differs from the app's. On discovery,
    // @vitejs/plugin-rsc re-resolves the import from the root and Vite serves
    // that copy to the adapter, so the root-form id matches.
    install("skewed-dep");
    install("skewed-dep", packageRoot);
    const entry = write("entry.js", 'import "skewed-dep";\nimport "real-dep/subpath";\n');

    expect(collect(entry)).toEqual(["real-dep/subpath", "skewed-dep"]);
  });

  it("skips dependencies that are not in node_modules from both the importer and the root", () => {
    // Linked from the root.
    const linkedRoot = path.join(root, "packages", "linked-dep");
    fs.mkdirSync(linkedRoot, { recursive: true });
    fs.writeFileSync(path.join(linkedRoot, "package.json"), JSON.stringify({ name: "linked-dep" }));
    fs.symlinkSync(linkedRoot, path.join(root, "node_modules", "linked-dep"), "junction");
    // Linked from the importer, with a real copy at the root.
    const importerLinkedRoot = path.join(root, "packages", "importer-linked-dep");
    fs.mkdirSync(importerLinkedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(importerLinkedRoot, "package.json"),
      JSON.stringify({ name: "importer-linked-dep" }),
    );
    install("importer-linked-dep");
    fs.mkdirSync(path.join(packageRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(
      importerLinkedRoot,
      path.join(packageRoot, "node_modules", "importer-linked-dep"),
      "junction",
    );
    // Only installed for the adapter, as under strict pnpm.
    install("adapter-only-dep", packageRoot);
    const entry = write(
      "entry.js",
      [
        'import "linked-dep";',
        'import "importer-linked-dep";',
        'import "adapter-only-dep";',
        'import "missing-dep";',
        'import "real-dep";',
      ].join("\n"),
    );

    expect(collect(entry)).toEqual(["real-dep"]);
  });

  it("keeps a linked adapter's dependency only when it shares the root's copy", () => {
    // A linked adapter lives outside node_modules, so Vite registers its own
    // copy before plugin-rsc re-resolves from the root. Only a root-form id
    // for that same copy preserves what the adapter is served.
    const adapterRoot = path.join(root, "packages", "linked-adapter");
    fs.mkdirSync(path.join(adapterRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(adapterRoot, "package.json"),
      JSON.stringify({ name: "@adapter/linked" }),
    );
    fs.symlinkSync(adapterRoot, path.join(root, "node_modules", "@adapter", "linked"), "junction");
    install("skewed-dep");
    install("skewed-dep", adapterRoot);
    // Both sides link to one store copy, as pnpm does.
    const storeCopy = install("store-dep", path.join(root, "node_modules", ".pnpm", "store-dep"));
    fs.symlinkSync(storeCopy, path.join(root, "node_modules", "store-dep"), "junction");
    fs.symlinkSync(storeCopy, path.join(adapterRoot, "node_modules", "store-dep"), "junction");
    fs.writeFileSync(
      path.join(adapterRoot, "dist", "entry.js"),
      ['import "skewed-dep";', 'import "store-dep";', 'import "real-dep";'].join("\n"),
    );

    expect(
      collect(path.join(root, "node_modules", "@adapter", "linked", "dist", "entry.js")),
    ).toEqual(["real-dep", "store-dep"]);
  });

  it("does not require the adapter itself to resolve from the root", () => {
    const entry = write("entry.js", 'import "real-dep";\n');
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-host-entry-root-"));
    try {
      install("real-dep", otherRoot);
      expect(collectHostEntryOptimizeDepsIncludes(entry, otherRoot, [])).toEqual(["real-dep"]);
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
