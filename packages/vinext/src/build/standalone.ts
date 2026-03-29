import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface StandaloneBuildOptions {
  root: string;
  outDir: string;
  /**
   * Test hook: override vinext package root used for embedding runtime files.
   */
  vinextPackageRoot?: string;
}

export interface StandaloneBuildResult {
  standaloneDir: string;
  copiedPackages: string[];
}

interface QueueEntry {
  packageName: string;
  resolver: NodeRequire;
  optional: boolean;
}

function readPackageJson(packageJsonPath: string): PackageJson {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as PackageJson;
}

function runtimeDeps(pkg: PackageJson): string[] {
  return Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  });
}

/**
 * Read the externals manifest written by the `vinext:server-externals-manifest`
 * Vite plugin during the production build.
 *
 * The manifest (`dist/server/vinext-externals.json`) contains the exact set of
 * npm packages that the bundler left external in the SSR/RSC output — i.e.
 * packages that the server bundle actually imports at runtime. Using this
 * instead of scanning emitted files with regexes or seeding from
 * `package.json#dependencies` avoids both false negatives (missed imports) and
 * false positives (client-only deps that are never loaded server-side).
 *
 * Falls back to an empty array if the manifest does not exist (e.g. when
 * running against a build that predates this feature).
 */
function readServerExternalsManifest(serverDir: string): string[] {
  const manifestPath = path.join(serverDir, "vinext-externals.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as string[];
  } catch {
    return [];
  }
}

function resolvePackageJsonPath(packageName: string, resolver: NodeRequire): string | null {
  try {
    return resolver.resolve(`${packageName}/package.json`);
  } catch {
    // Some packages do not export ./package.json via exports map.
    // Fallback: resolve package entry and walk up to the nearest matching package.json.
    try {
      const entryPath = resolver.resolve(packageName);
      let dir = path.dirname(entryPath);
      while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, "package.json");
        if (fs.existsSync(candidate)) {
          const pkg = readPackageJson(candidate);
          if (pkg.name === packageName) {
            return candidate;
          }
        }
        dir = path.dirname(dir);
      }
    } catch {
      // fallthrough to null
    }
    return null;
  }
}

function copyPackageAndRuntimeDeps(
  root: string,
  targetNodeModulesDir: string,
  initialPackages: string[],
): string[] {
  const rootResolver = createRequire(path.join(root, "package.json"));
  const rootPkg = readPackageJson(path.join(root, "package.json"));
  const rootOptional = new Set(Object.keys(rootPkg.optionalDependencies ?? {}));
  const copied = new Set<string>();
  const queue: QueueEntry[] = initialPackages.map((packageName) => ({
    packageName,
    resolver: rootResolver,
    optional: rootOptional.has(packageName),
  }));

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) continue;
    if (copied.has(entry.packageName)) continue;

    const packageJsonPath = resolvePackageJsonPath(entry.packageName, entry.resolver);
    if (!packageJsonPath) {
      if (entry.optional) {
        continue;
      }
      throw new Error(
        `Failed to resolve required runtime dependency "${entry.packageName}" for standalone output`,
      );
    }

    const packageRoot = path.dirname(packageJsonPath);
    const packageTarget = path.join(targetNodeModulesDir, entry.packageName);
    fs.mkdirSync(path.dirname(packageTarget), { recursive: true });
    fs.cpSync(packageRoot, packageTarget, { recursive: true, dereference: true });

    copied.add(entry.packageName);

    const packageResolver = createRequire(packageJsonPath);
    const pkg = readPackageJson(packageJsonPath);
    const optionalDeps = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    for (const depName of runtimeDeps(pkg)) {
      if (!copied.has(depName)) {
        queue.push({
          packageName: depName,
          resolver: packageResolver,
          optional: optionalDeps.has(depName),
        });
      }
    }
  }

  return [...copied];
}

function resolveVinextPackageRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // dist/build/standalone.js -> package root is ../..
  return path.resolve(currentDir, "..", "..");
}

function writeStandaloneServerEntry(filePath: string): void {
  const content = `#!/usr/bin/env node
const path = require("node:path");

async function main() {
  const { startProdServer } = await import("vinext/server/prod-server");
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  await startProdServer({
    port,
    host,
    outDir: path.join(__dirname, "dist"),
  });
}

main().catch((error) => {
  console.error("[vinext] Failed to start standalone server");
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(filePath, content, "utf-8");
  fs.chmodSync(filePath, 0o755);
}

function writeStandalonePackageJson(filePath: string): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        private: true,
        type: "commonjs",
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

/**
 * Emit standalone production output for self-hosted deployments.
 *
 * Creates:
 * - <outDir>/standalone/server.js
 * - <outDir>/standalone/dist/{client,server}
 * - <outDir>/standalone/node_modules (runtime deps only)
 *
 * The set of packages copied into node_modules/ is determined by
 * `dist/server/vinext-externals.json`, which is written by the
 * `vinext:server-externals-manifest` Vite plugin during the production build.
 * It contains exactly the packages the server bundle imports at runtime
 * (i.e. those left external by the bundler), so no client-only deps are
 * included.
 */
export function emitStandaloneOutput(options: StandaloneBuildOptions): StandaloneBuildResult {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const clientDir = path.join(outDir, "client");
  const serverDir = path.join(outDir, "server");

  if (!fs.existsSync(clientDir) || !fs.existsSync(serverDir)) {
    throw new Error(`No build output found in ${outDir}. Run vinext build first.`);
  }

  const standaloneDir = path.join(outDir, "standalone");
  const standaloneDistDir = path.join(standaloneDir, "dist");
  const standaloneNodeModulesDir = path.join(standaloneDir, "node_modules");

  fs.rmSync(standaloneDir, { recursive: true, force: true });
  fs.mkdirSync(standaloneDistDir, { recursive: true });

  fs.cpSync(clientDir, path.join(standaloneDistDir, "client"), {
    recursive: true,
    dereference: true,
  });
  fs.cpSync(serverDir, path.join(standaloneDistDir, "server"), {
    recursive: true,
    dereference: true,
  });

  const publicDir = path.join(root, "public");
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, path.join(standaloneDir, "public"), {
      recursive: true,
      dereference: true,
    });
  }

  fs.mkdirSync(standaloneNodeModulesDir, { recursive: true });

  // Seed from the manifest written by vinext:server-externals-manifest during
  // the production build. This is the authoritative list of packages the server
  // bundle actually imports at runtime — determined by the bundler's own graph,
  // not regex scanning or package.json#dependencies.
  const initialPackages = readServerExternalsManifest(serverDir).filter(
    (name) => name !== "vinext",
  );
  const copiedPackages = copyPackageAndRuntimeDeps(root, standaloneNodeModulesDir, initialPackages);

  // Always embed the exact vinext runtime that produced this build.
  const vinextPackageRoot = resolveVinextPackageRoot(options.vinextPackageRoot);
  const vinextDistDir = path.join(vinextPackageRoot, "dist");
  if (!fs.existsSync(vinextDistDir)) {
    throw new Error(`vinext runtime dist/ not found at ${vinextPackageRoot}`);
  }
  const vinextTargetDir = path.join(standaloneNodeModulesDir, "vinext");
  fs.mkdirSync(vinextTargetDir, { recursive: true });
  fs.copyFileSync(
    path.join(vinextPackageRoot, "package.json"),
    path.join(vinextTargetDir, "package.json"),
  );
  fs.cpSync(vinextDistDir, path.join(vinextTargetDir, "dist"), {
    recursive: true,
    dereference: true,
  });

  writeStandaloneServerEntry(path.join(standaloneDir, "server.js"));
  writeStandalonePackageJson(path.join(standaloneDir, "package.json"));

  return {
    standaloneDir,
    copiedPackages: [...new Set([...copiedPackages, "vinext"])],
  };
}
