import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createStyledJsxDependencyGraph } from "../packages/vinext/src/utils/styled-jsx-dependencies.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-styled-jsx-deps-"));
  temporaryDirectories.push(root);
  return root;
}

/** Install a package directory with the given runtime dependency fields. */
function installPackage(dir: string, name: string, fields: Record<string, object> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, ...fields }));
  return dir;
}

// A package that ships `<style jsx>` precompiled declares styled-jsx; it may
// sit behind packages that do not (the app depends on A, A on B).
describe("styled-jsx dependency graph", () => {
  it("finds packages declaring styled-jsx directly or behind dependency edges", () => {
    const root = createRoot();
    const nodeModules = path.join(root, "node_modules");
    // npm/yarn: hoisted into the app's node_modules.
    installPackage(path.join(nodeModules, "inner"), "inner", {
      peerDependencies: { react: "*", "styled-jsx": "*" },
    });
    installPackage(path.join(nodeModules, "outer"), "outer", { dependencies: { middle: "1" } });
    installPackage(path.join(nodeModules, "middle"), "middle", {
      optionalDependencies: { inner: "1" },
    });
    installPackage(path.join(nodeModules, "plain"), "plain", { dependencies: { react: "19" } });
    // Only its own development needs styled-jsx.
    installPackage(path.join(nodeModules, "dev-only"), "dev-only", {
      devDependencies: { "styled-jsx": "5" },
    });
    const graph = createStyledJsxDependencyGraph();

    expect(graph.dependencyReachesStyledJsx(root, "inner")).toBe(true);
    expect(graph.dependencyReachesStyledJsx(root, "outer")).toBe(true);
    expect(graph.packageReachesStyledJsx(path.join(nodeModules, "middle"))).toBe(true);
    expect(graph.dependencyReachesStyledJsx(root, "plain")).toBe(false);
    expect(graph.dependencyReachesStyledJsx(root, "dev-only")).toBe(false);
    expect(graph.dependencyReachesStyledJsx(root, "missing")).toBe(false);
    expect(graph.dependencyReachesStyledJsx(root, "styled-jsx")).toBe(true);
  });

  it("resolves dependencies the way Node does in a pnpm layout", () => {
    const root = createRoot();
    const store = path.join(root, "node_modules", ".pnpm");
    // pnpm keeps each package's dependencies beside it in the store.
    const outer = installPackage(path.join(store, "outer@1", "node_modules", "outer"), "outer", {
      dependencies: { inner: "1" },
    });
    const inner = installPackage(path.join(store, "inner@1", "node_modules", "inner"), "inner", {
      dependencies: { "styled-jsx": "5" },
    });
    fs.symlinkSync(inner, path.join(store, "outer@1", "node_modules", "inner"), "dir");
    fs.symlinkSync(outer, path.join(root, "node_modules", "outer"), "dir");

    expect(createStyledJsxDependencyGraph().dependencyReachesStyledJsx(root, "outer")).toBe(true);
  });

  it("never counts Next.js, which always depends on styled-jsx", () => {
    const root = createRoot();
    const nodeModules = path.join(root, "node_modules");
    installPackage(path.join(nodeModules, "next"), "next", {
      dependencies: { "styled-jsx": "5.1.6" },
    });
    installPackage(path.join(nodeModules, "next-auth"), "next-auth", {
      peerDependencies: { next: "*", react: "*" },
    });
    const graph = createStyledJsxDependencyGraph();

    expect(graph.dependencyReachesStyledJsx(root, "next")).toBe(false);
    expect(graph.dependencyReachesStyledJsx(root, "next-auth")).toBe(false);
  });

  it("walks dependency cycles once and still answers for every package in them", () => {
    const root = createRoot();
    const nodeModules = path.join(root, "node_modules");
    installPackage(path.join(nodeModules, "a"), "a", { dependencies: { b: "1" } });
    installPackage(path.join(nodeModules, "b"), "b", { dependencies: { a: "1", c: "1" } });
    installPackage(path.join(nodeModules, "c"), "c", { peerDependencies: { "styled-jsx": "5" } });
    installPackage(path.join(nodeModules, "x"), "x", { dependencies: { y: "1" } });
    installPackage(path.join(nodeModules, "y"), "y", { dependencies: { x: "1" } });
    const graph = createStyledJsxDependencyGraph();

    expect(graph.dependencyReachesStyledJsx(root, "a")).toBe(true);
    expect(graph.dependencyReachesStyledJsx(root, "b")).toBe(true);
    expect(graph.dependencyReachesStyledJsx(root, "x")).toBe(false);
    expect(graph.dependencyReachesStyledJsx(root, "y")).toBe(false);
  });
});
