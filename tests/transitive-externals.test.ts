import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  _createPluginForTest,
  compareTransitiveExternalResolutions,
  resolveTransitiveExternal,
} from "../packages/vinext/src/plugins/transitive-externals.js";

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-transitive-externals-"));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

type PackageOptions = {
  parent?: string; // node_modules location to install under
};

function writePackage(
  root: string,
  packageName: string,
  version: string,
  dependencies: Record<string, string> = {},
  opts: PackageOptions = {},
): string {
  const nestedNm = opts.parent ?? path.join(root, "node_modules");
  const packageRoot = path.join(nestedNm, packageName);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version, main: "index.js", dependencies }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(packageRoot, "index.js"),
    `module.exports = { name: ${JSON.stringify(packageName)}, version: ${JSON.stringify(version)} };\n`,
    "utf-8",
  );
  return packageRoot;
}

/**
 * Build a layout matching Next.js's `externals-transitive` fixture:
 *
 *   <root>/node_modules/lodash@3.10.1            (root copy)
 *   <root>/node_modules/dep-a/                   (depends on lodash@3, resolves to root copy)
 *   <root>/node_modules/dep-b/                   (depends on lodash@4)
 *   <root>/node_modules/dep-b/node_modules/lodash@4.17.21  (nested copy)
 */
function buildFixture(root: string): { depA: string; depB: string } {
  writeFile(
    root,
    "package.json",
    JSON.stringify({ name: "app", dependencies: { lodash: "3.10.1" } }, null, 2),
  );
  writePackage(root, "lodash", "3.10.1");
  const depA = writePackage(root, "dep-a", "1.0.0", { lodash: "3.10.1" });
  const depB = writePackage(root, "dep-b", "1.0.0", { lodash: "4.17.21" });
  writePackage(
    root,
    "lodash",
    "4.17.21",
    {},
    {
      parent: path.join(depB, "node_modules"),
    },
  );
  return { depA, depB };
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveTransitiveExternal", () => {
  it("bundles when the resolved path matches but the module mode differs", () => {
    writeFile(tmpDir, "shared.js", "export default 'shared';\n");
    const sharedPath = path.join(tmpDir, "shared.js");

    expect(
      compareTransitiveExternalResolutions(
        { path: sharedPath, mode: "import" },
        { path: sharedPath, mode: "require" },
      ),
    ).toBe(fs.realpathSync(sharedPath));
  });

  it("returns the nested copy when the importer resolves to a different version than root", () => {
    buildFixture(tmpDir);

    const rootResolver = createRequire(path.join(tmpDir, "package.json"));
    const depBIndex = path.join(tmpDir, "node_modules", "dep-b", "index.js");

    const resolved = resolveTransitiveExternal("lodash", depBIndex, rootResolver);

    expect(resolved).not.toBeNull();
    // The resolved path must point at dep-b's nested lodash copy, not the
    // root-level one.
    expect(resolved).toBe(
      fs.realpathSync(
        path.join(tmpDir, "node_modules", "dep-b", "node_modules", "lodash", "index.js"),
      ),
    );
  });

  it("returns null when the importer's resolution matches the root resolution", () => {
    buildFixture(tmpDir);

    const rootResolver = createRequire(path.join(tmpDir, "package.json"));
    // dep-a depends on lodash@3 which is already at the root — no disambiguation needed.
    const depAIndex = path.join(tmpDir, "node_modules", "dep-a", "index.js");

    const resolved = resolveTransitiveExternal("lodash", depAIndex, rootResolver);
    expect(resolved).toBeNull();
  });

  it("returns null when the request cannot be resolved from the importer", () => {
    buildFixture(tmpDir);

    const rootResolver = createRequire(path.join(tmpDir, "package.json"));
    const depAIndex = path.join(tmpDir, "node_modules", "dep-a", "index.js");

    const resolved = resolveTransitiveExternal("does-not-exist", depAIndex, rootResolver);
    expect(resolved).toBeNull();
  });

  it("returns the importer-side resolution when the root cannot resolve the request", () => {
    // Layout: only dep-b has lodash in its nested node_modules (no root-level lodash).
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "app" }, null, 2));
    const depB = writePackage(tmpDir, "dep-b", "1.0.0", { lodash: "4.17.21" });
    writePackage(tmpDir, "lodash", "4.17.21", {}, { parent: path.join(depB, "node_modules") });

    const rootResolver = createRequire(path.join(tmpDir, "package.json"));
    const depBIndex = path.join(depB, "index.js");

    const resolved = resolveTransitiveExternal("lodash", depBIndex, rootResolver);
    expect(resolved).toBe(fs.realpathSync(path.join(depB, "node_modules", "lodash", "index.js")));
  });
});

describe("vinext:transitive-externals plugin", () => {
  /**
   * Build a plugin instance and call `configResolved` once, matching Vite's
   * real lifecycle (lifecycle hooks fire once per build, not per resolveId
   * call). Tests then invoke the returned `resolveId` helper as many times
   * as they need against the same initialized instance.
   */
  function setupPlugin(options: {
    root: string;
    externalPackages: string[];
    environment?: string;
  }) {
    const plugin = _createPluginForTest({
      root: options.root,
      externalPackages: options.externalPackages,
    });
    const configResolved = plugin.configResolved;
    if (typeof configResolved === "function") {
      // biome-ignore lint/suspicious/noExplicitAny: invoking lifecycle hooks manually for testing
      (configResolved as any).call({});
    }
    const hook = plugin.resolveId;
    if (typeof hook !== "function") throw new Error("plugin.resolveId must be a function");
    const ctx = { environment: { name: options.environment ?? "ssr" } };
    const resolveId = (source: string, importer: string): string | null => {
      // biome-ignore lint/suspicious/noExplicitAny: invoking lifecycle hooks manually for testing
      const result = (hook as any).call(ctx, source, importer);
      if (result == null) return null;
      if (typeof result === "string") return result;
      if (typeof result === "object" && result !== null && "id" in result) {
        return (result as { id: string }).id;
      }
      return null;
    };
    return { plugin, resolveId };
  }

  it("redirects the import to the nested copy when versions differ (#1503)", () => {
    const { depB } = buildFixture(tmpDir);
    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["lodash"],
    });
    const result = resolveId("lodash", path.join(depB, "index.js"));
    expect(result).toBe(fs.realpathSync(path.join(depB, "node_modules", "lodash", "index.js")));
  });

  it("leaves the import alone when the importer would resolve to the root copy", () => {
    const { depA } = buildFixture(tmpDir);
    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["lodash"],
    });
    const result = resolveId("lodash", path.join(depA, "index.js"));
    expect(result).toBeNull();
  });

  it("ignores packages that are not in the externals list", () => {
    const { depB } = buildFixture(tmpDir);
    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["@storybook/global"],
    });
    const result = resolveId("lodash", path.join(depB, "index.js"));
    expect(result).toBeNull();
  });

  it("ignores user-source importers (outside node_modules)", () => {
    buildFixture(tmpDir);
    writeFile(tmpDir, "app/page.js", "import 'lodash';\n");
    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["lodash"],
    });
    const result = resolveId("lodash", path.join(tmpDir, "app/page.js"));
    expect(result).toBeNull();
  });

  it("bundles nested-only externals imported from a linked package realpath", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "app" }, null, 2));
    const linkedPackage = path.join(tmpDir, "packages", "dep-b");
    writePackage(
      tmpDir,
      "dep-b",
      "1.0.0",
      { lodash: "4.17.21" },
      { parent: path.join(tmpDir, "packages") },
    );
    writePackage(
      tmpDir,
      "lodash",
      "4.17.21",
      {},
      { parent: path.join(linkedPackage, "node_modules") },
    );

    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["lodash"],
    });
    const result = resolveId("lodash", path.join(linkedPackage, "index.js"));

    expect(result).toBe(fs.realpathSync(path.join(linkedPackage, "node_modules/lodash/index.js")));
  });

  it("ignores virtual / non-absolute importers", () => {
    buildFixture(tmpDir);
    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["lodash"],
    });
    expect(resolveId("lodash", "\0virtual:vinext-server-entry")).toBeNull();
    expect(resolveId("lodash", "virtual:some-module")).toBeNull();
  });

  it("matches scoped package names correctly", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "app" }, null, 2));
    writePackage(tmpDir, "@scope/dep", "1.0.0", { "@scope/lib": "2.0.0" });
    writePackage(tmpDir, "@scope/lib", "1.0.0");
    const depRoot = path.join(tmpDir, "node_modules", "@scope/dep");
    writePackage(tmpDir, "@scope/lib", "2.0.0", {}, { parent: path.join(depRoot, "node_modules") });

    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["@scope/lib"],
    });
    const result = resolveId("@scope/lib", path.join(depRoot, "index.js"));
    expect(result).toBe(
      fs.realpathSync(path.join(depRoot, "node_modules", "@scope/lib", "index.js")),
    );
  });

  it("resolves subpath imports against the nested copy (e.g. lodash/cloneDeep)", () => {
    // Layout: root has lodash@3, dep-b has nested lodash@4 with a subpath file.
    writeFile(
      tmpDir,
      "package.json",
      JSON.stringify({ name: "app", dependencies: { lodash: "3.10.1" } }, null, 2),
    );
    writePackage(tmpDir, "lodash", "3.10.1");
    // Add a subpath file (cloneDeep.js) to the root copy so it resolves.
    writeFile(
      tmpDir,
      "node_modules/lodash/cloneDeep.js",
      "module.exports = function cloneDeep() {};\n",
    );
    const depB = writePackage(tmpDir, "dep-b", "1.0.0", { lodash: "4.17.21" });
    writePackage(tmpDir, "lodash", "4.17.21", {}, { parent: path.join(depB, "node_modules") });
    writeFile(
      tmpDir,
      "node_modules/dep-b/node_modules/lodash/cloneDeep.js",
      "module.exports = function cloneDeep4() {};\n",
    );

    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["lodash"],
    });
    const result = resolveId("lodash/cloneDeep", path.join(depB, "index.js"));
    // Subpath should resolve through pkgName extraction ("lodash") and
    // return the nested copy's cloneDeep.js, not the root's.
    expect(result).toBe(fs.realpathSync(path.join(depB, "node_modules", "lodash", "cloneDeep.js")));
  });

  it("resolves scoped subpath imports against the nested copy (e.g. @scope/lib/utils)", () => {
    writeFile(tmpDir, "package.json", JSON.stringify({ name: "app" }, null, 2));
    writePackage(tmpDir, "@scope/dep", "1.0.0", { "@scope/lib": "2.0.0" });
    writePackage(tmpDir, "@scope/lib", "1.0.0");
    writeFile(tmpDir, "node_modules/@scope/lib/utils.js", "module.exports = { which: 'root' };\n");
    const depRoot = path.join(tmpDir, "node_modules", "@scope/dep");
    writePackage(tmpDir, "@scope/lib", "2.0.0", {}, { parent: path.join(depRoot, "node_modules") });
    writeFile(
      tmpDir,
      path.join("node_modules", "@scope/dep", "node_modules", "@scope/lib", "utils.js"),
      "module.exports = { which: 'nested' };\n",
    );

    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["@scope/lib"],
    });
    const result = resolveId("@scope/lib/utils", path.join(depRoot, "index.js"));
    // Scoped subpath: pkgName extraction takes "@scope/lib", then the
    // subpath ("utils") resolves against the nested copy.
    expect(result).toBe(
      fs.realpathSync(path.join(depRoot, "node_modules", "@scope/lib", "utils.js")),
    );
  });

  it("is inert in the client environment", () => {
    const { depB } = buildFixture(tmpDir);
    const { resolveId } = setupPlugin({
      root: tmpDir,
      externalPackages: ["lodash"],
      environment: "client",
    });
    // Even with a real version mismatch, the plugin must return null in
    // client builds (resolve.external is never configured there).
    const result = resolveId("lodash", path.join(depB, "index.js"));
    expect(result).toBeNull();
  });
});
