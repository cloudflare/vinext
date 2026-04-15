import { describe, it, expect, afterEach } from "vite-plus/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildBarrelExportMap,
  createOptimizeImportsPlugin,
} from "../packages/vinext/src/plugins/optimize-imports.js";
import type { Plugin } from "vite-plus";

function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

let testId = 0;
function uniquePath(name: string): string {
  return `/fake/${name}-${++testId}/entry.js`;
}

describe("optimize-imports targeted regressions", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not record phantom function/class exports in fallback default-export parsing", async () => {
    const entryPath = uniquePath("fallback-default-function");
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () =>
        Promise.resolve(
          `export default function Button() { return <div />; }\nexport class Card {}`,
        ),
    );

    expect(map).not.toBeNull();
    expect(map!.get("default")).toEqual({
      source: entryPath,
      isNamespace: false,
      originalName: "default",
    });
    expect(map!.has("function")).toBe(false);
    expect(map!.has("class")).toBe(false);
    expect(map!.has("Button")).toBe(false);
    expect(map!.get("Card")).toEqual({
      source: entryPath,
      isNamespace: false,
      originalName: "Card",
    });
  });

  it("issue-845 multi-hop antd barrel rewrites past intermediate barrel index", async () => {
    // Ported from issue-845 parity notes: `.sisyphus/evidence/task-1-parity-matrix.md`
    // Repro shape matches the documented `antd` optimization path, where the root barrel
    // points at `es/button/index.js` but the concrete implementation lives deeper.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );

    const pkgDir = path.join(tmpDir, "node_modules", "antd");
    fs.mkdirSync(path.join(pkgDir, "es", "button"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "antd", type: "module", main: "./index.js" }),
    );
    fs.writeFileSync(
      path.join(pkgDir, "index.js"),
      `export { Button } from "./es/button/index.js";`,
    );
    fs.writeFileSync(
      path.join(pkgDir, "es", "button", "index.js"),
      [`export * from "./style.js";`, `export { Button } from "./button.js";`].join("\n"),
    );
    fs.writeFileSync(path.join(pkgDir, "es", "button", "style.js"), `export const wave = true;`);
    fs.writeFileSync(
      path.join(pkgDir, "es", "button", "button.js"),
      `export function Button() { return null; }`,
    );

    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;

    const result = await (transform as any).call(
      { ...plugin, environment: { name: "rsc" } },
      `import { Button } from "antd";`,
      "/app/page.tsx",
    );

    expect(result).not.toBeNull();

    const intermediateBarrel = path.join(pkgDir, "es", "button", "index");
    const concreteModule = path.join(pkgDir, "es", "button", "button.js");

    expect(result!.code).not.toContain(`from "antd"`);
    expect(result!.code).not.toContain(JSON.stringify(intermediateBarrel));
    expect(result!.code).toContain(JSON.stringify(concreteModule));
  });

  it("keeps optimizing issue-845 imports from JSX-bearing TSX user files", async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-optimize-test-")));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-app", type: "module" }),
    );

    const pkgDir = path.join(tmpDir, "node_modules", "antd");
    fs.mkdirSync(path.join(pkgDir, "es", "button"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "antd", type: "module", main: "./index.js" }),
    );
    fs.writeFileSync(
      path.join(pkgDir, "index.js"),
      `export { Button } from "./es/button/index.js";`,
    );
    fs.writeFileSync(
      path.join(pkgDir, "es", "button", "index.js"),
      [`export * from "./style.js";`, `export { Button } from "./button.js";`].join("\n"),
    );
    fs.writeFileSync(path.join(pkgDir, "es", "button", "style.js"), `export const wave = true;`);
    fs.writeFileSync(
      path.join(pkgDir, "es", "button", "button.js"),
      `export function Button() { return null; }`,
    );

    const plugin = createOptimizeImportsPlugin(
      () => undefined,
      () => tmpDir,
    ) as Plugin;
    const buildStartHook = unwrapHook((plugin as any).buildStart);
    if (buildStartHook) await buildStartHook.call(plugin);
    const transform = unwrapHook(plugin.transform)!;

    const result = await (transform as any).call(
      { ...plugin, environment: { name: "rsc" } },
      `import { Button } from "antd";\nexport default function Demo() { return <Button />; }`,
      "/app/page.tsx",
    );

    expect(result).not.toBeNull();

    const intermediateBarrel = path.join(pkgDir, "es", "button", "index");
    const concreteModule = path.join(pkgDir, "es", "button", "button.js");

    expect(result!.code).not.toContain(`from "antd"`);
    expect(result!.code).not.toContain(JSON.stringify(intermediateBarrel));
    expect(result!.code).toContain(JSON.stringify(concreteModule));
    expect(result!.code).toContain("return <Button />");
  });
});
