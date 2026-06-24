import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { findInNodeModules, findViteConfigPath } from "../utils/project.js";

export type ProjectInfo = {
  root: string;
  isAppRouter: boolean;
  isPagesRouter: boolean;
  hasViteConfig: boolean;
  hasWranglerConfig: boolean;
  hasWorkerEntry: boolean;
  hasCloudflarePlugin: boolean;
  hasRscPlugin: boolean;
  hasWrangler: boolean;
  projectName: string;
  /** Pages that use `revalidate` (ISR) */
  hasISR: boolean;
  /** package.json has "type": "module" */
  hasTypeModule: boolean;
  /** .mdx files detected in app/ or pages/ */
  hasMDX: boolean;
  /** CodeHike is a dependency */
  hasCodeHike: boolean;
  /** Native Node modules that need stubbing for Workers */
  nativeModulesToStub: string[];
};

// ─── Detection ───────────────────────────────────────────────────────────────

/** Check whether a wrangler config file exists in the given directory. */
export function hasWranglerConfig(root: string): boolean {
  return (
    fs.existsSync(path.join(root, "wrangler.jsonc")) ||
    fs.existsSync(path.join(root, "wrangler.json")) ||
    fs.existsSync(path.join(root, "wrangler.toml")) ||
    fs.existsSync(path.join(root, "cloudflare.config.ts"))
  );
}

/**
 * Detect the project structure (router, config, worker entry, package name).
 *
 * `root` is an OS-native filesystem path.
 */
export function detectProject(root: string): ProjectInfo {
  const hasApp = resolveProjectDir(root, "app") !== null;
  const hasPages = resolveProjectDir(root, "pages") !== null;

  // Prefer App Router if both exist
  const isAppRouter = hasApp;
  const isPagesRouter = !hasApp && hasPages;

  const hasViteConfig = findViteConfigPath(root) !== undefined;

  const wranglerConfigExists = hasWranglerConfig(root);

  const hasWorkerEntry =
    fs.existsSync(path.join(root, "worker", "index.ts")) ||
    fs.existsSync(path.join(root, "worker", "index.js"));

  // Check node_modules for installed packages.
  // Walk up ancestor directories so that monorepo-hoisted packages are found
  // even when node_modules lives at the workspace root rather than app root.
  const hasCloudflarePlugin = findInNodeModules(root, "@cloudflare/vite-plugin") !== null;
  const hasRscPlugin = findInNodeModules(root, "@vitejs/plugin-rsc") !== null;
  const hasWrangler =
    findInNodeModules(root, ".bin/wrangler") !== null ||
    findInNodeModules(root, ".bin/cf") !== null;

  // Parse package.json once for all fields that need it
  const pkgPath = path.join(root, "package.json");
  let pkg: Record<string, unknown> | null = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    } catch {
      // ignore parse errors
    }
  }

  // Derive project name from package.json or directory name
  let projectName = path.basename(root);
  if (pkg?.name && typeof pkg.name === "string") {
    // Sanitize: Workers names must be lowercase alphanumeric + hyphens
    projectName = pkg.name
      .replace(/^@[^/]+\//, "") // strip npm scope
      .toLowerCase() // lowercase BEFORE stripping invalid chars
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  // Detect "type": "module" in package.json
  const hasTypeModule = pkg?.type === "module";

  // Detect ISR and MDX usage. Both scan the same
  // app/ tree, so they share a single recursive walk per directory instead of
  // walking it twice. ISR is App-Router-only (Pages Router ISR isn't detected
  // here — see note below); MDX may also be declared in next.config.
  let hasISR = false;
  let hasMDX = detectMDXFromConfig(root);

  if (isAppRouter) {
    const appDir = resolveProjectDir(root, "app");
    if (appDir) {
      const found = scanTreeForDetection(appDir, { isr: true, mdx: !hasMDX });
      hasISR = found.isr;
      hasMDX = hasMDX || found.mdx;
    }
  }

  if (hasPages) {
    const pagesDir = resolveProjectDir(root, "pages");
    if (pagesDir) {
      const found = scanTreeForDetection(pagesDir, { isr: !hasISR, mdx: !hasMDX });
      hasISR = hasISR || found.isr;
      hasMDX = hasMDX || found.mdx;
    }
  }

  hasISR = hasISR || detectCacheComponents(root);

  // Detect CodeHike dependency
  const allDeps = {
    ...(pkg?.dependencies as Record<string, unknown> | undefined),
    ...(pkg?.devDependencies as Record<string, unknown> | undefined),
  };
  const hasCodeHike = "codehike" in allDeps;

  // Detect native Node modules that need stubbing for Workers. Reuses the
  // already-merged dependency map instead of re-reading/re-parsing package.json.
  const nativeModulesToStub = detectNativeModules(allDeps);

  return {
    root,
    isAppRouter,
    isPagesRouter,
    hasViteConfig,
    hasWranglerConfig: wranglerConfigExists,
    hasWorkerEntry,
    hasCloudflarePlugin,
    hasRscPlugin,
    hasWrangler,
    projectName,
    hasISR,
    hasTypeModule,
    hasMDX,
    hasCodeHike,
    nativeModulesToStub,
  };
}

/** Matches App Router revalidation or Pages Router static generation exports. */
const ISR_PATTERN =
  /export\s+(?:const\s+revalidate\s*=|(?:async\s+)?function\s+getStaticProps\b|const\s+getStaticProps\s*=|\{[^}]*\bgetStaticProps\b[^}]*\})/;

/** Source extensions whose contents are scanned for the ISR pattern. */
const ISR_SCANNABLE_EXTENSION = /\.(ts|tsx|js|jsx)$/;

/**
 * Resolve a project subdirectory (`app`/`pages`), preferring the root-level
 * location and falling back to the `src/` variant. Returns null when neither
 * exists.
 */
function resolveProjectDir(root: string, name: string): string | null {
  const rootDir = path.join(root, name);
  try {
    if (fs.statSync(rootDir).isDirectory()) return rootDir;
  } catch {
    // Try the src/ variant.
  }
  const srcDir = path.join(root, "src", name);
  try {
    if (fs.statSync(srcDir).isDirectory()) return srcDir;
  } catch {
    // Not found or not a directory.
  }
  return null;
}

/**
 * Recursively walk `dir` once, evaluating the requested detection predicates
 * per entry. Each flag short-circuits independently: an `.mdx` file sets `mdx`;
 * a scannable source file containing `export const revalidate` sets `isr`. The
 * walk stops as soon as every requested flag is satisfied, so callers that only
 * want one signal don't pay for the other.
 *
 * Replaces the previous pair of single-purpose recursive walkers
 * (`scanDirForPattern` + `scanDirForExtension`) that traversed the same tree
 * twice. Detection semantics are unchanged: same dirs skipped (dotfiles,
 * node_modules), same extension and content tests.
 */
function scanTreeForDetection(
  dir: string,
  want: { isr: boolean; mdx: boolean },
): { isr: boolean; mdx: boolean } {
  const found = { isr: false, mdx: false };

  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Stop early once every requested flag is satisfied.
      if ((!want.isr || found.isr) && (!want.mdx || found.mdx)) return;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (want.mdx && !found.mdx && entry.name.endsWith(".mdx")) {
          found.mdx = true;
        }
        if (want.isr && !found.isr && ISR_SCANNABLE_EXTENSION.test(entry.name)) {
          try {
            if (ISR_PATTERN.test(fs.readFileSync(fullPath, "utf-8"))) {
              found.isr = true;
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }
  };

  walk(dir);
  return found;
}

/**
 * Detect MDX usage declared in next.config (`pageExtensions` including "mdx" or
 * an `@next/mdx` import). Filesystem `.mdx` detection is handled separately by
 * the shared app/pages tree walk in `detectProject`.
 */
function detectMDXFromConfig(root: string): boolean {
  // Mirror the Next.js-compatible set in shims/constants.ts. We accept
  // `.cjs` and `.cts` defensively in case a user has them — Next.js itself
  // does not, but `findNextConfigPath` will only return the first match in
  // the canonical order, so adding extra extensions here is harmless.
  const configFiles = [
    "next.config.ts",
    "next.config.mts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
  ];
  for (const f of configFiles) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, "utf-8");
        if (/pageExtensions.*mdx/i.test(content) || /@next\/mdx/.test(content)) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

function detectCacheComponents(root: string): boolean {
  const configFiles = [
    "next.config.ts",
    "next.config.mts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
  ];
  for (const fileName of configFiles) {
    const configPath = path.join(root, fileName);
    if (!fs.existsSync(configPath)) continue;
    try {
      if (/\bcacheComponents\s*:\s*true\b/.test(fs.readFileSync(configPath, "utf-8"))) {
        return true;
      }
    } catch {
      // ignore unreadable config files
    }
  }
  return false;
}

/** Known native Node modules that can't run in Workers */
const NATIVE_MODULES_TO_STUB = [
  "@resvg/resvg-js",
  "satori",
  "lightningcss",
  "@napi-rs/canvas",
  "sharp",
];

/**
 * Detect native Node modules in the project's merged dependency map that need
 * stubbing for Workers. Accepts the already-built `allDeps` (dependencies +
 * devDependencies) so package.json is not re-read or re-parsed.
 */
function detectNativeModules(allDeps: Record<string, unknown>): string[] {
  return NATIVE_MODULES_TO_STUB.filter((mod) => mod in allDeps);
}

// ─── Dependency Management ───────────────────────────────────────────────────

type MissingDep = {
  name: string;
  version: string;
};

/**
 * Check if a package is resolvable from a given root directory using
 * Node's module resolution (createRequire). Handles hoisting, pnpm
 * symlinks, monorepos, and Yarn PnP correctly.
 */
export function isPackageResolvable(root: string, packageName: string): boolean {
  try {
    const req = createRequire(path.join(root, "package.json"));
    req.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

export function getMissingDeps(
  info: ProjectInfo,
  /** Override for testing — defaults to `isPackageResolvable` */
  _isResolvable: (root: string, pkg: string) => boolean = isPackageResolvable,
): MissingDep[] {
  const missing: MissingDep[] = [];

  if (!info.hasCloudflarePlugin) {
    missing.push({ name: "@cloudflare/vite-plugin", version: "latest" });
  }
  if (!info.hasWrangler) {
    missing.push({ name: "wrangler", version: "latest" });
  }
  if (!_isResolvable(info.root, "@vitejs/plugin-react")) {
    missing.push({ name: "@vitejs/plugin-react", version: "latest" });
  }
  if (info.isAppRouter && !info.hasRscPlugin) {
    missing.push({ name: "@vitejs/plugin-rsc", version: "latest" });
  }
  if (info.isAppRouter) {
    // react-server-dom-webpack must be resolvable from the project root for Vite.
    if (!_isResolvable(info.root, "react-server-dom-webpack")) {
      missing.push({ name: "react-server-dom-webpack", version: "latest" });
    }
  }
  if (info.hasMDX) {
    // @mdx-js/rollup must be resolvable from the project root for Vite.
    if (!_isResolvable(info.root, "@mdx-js/rollup")) {
      missing.push({ name: "@mdx-js/rollup", version: "latest" });
    }
  }

  return missing;
}
