/**
 * Shared project utilities — used by both `vinext init` and `vinext deploy`.
 *
 * These functions detect and modify project configuration without touching
 * any Next.js source files, config files, or tsconfig.json.
 */

import fs from "node:fs";
import path from "node:path";

// ─── CJS Config Handling ─────────────────────────────────────────────────────

/** Common CJS config files that may need renaming when adding "type": "module" */
const CJS_CONFIG_FILES = [
  "postcss.config.js",
  "tailwind.config.js",
  ".eslintrc.js",
  "prettier.config.js",
  "stylelint.config.js",
  "commitlint.config.js",
  "jest.config.js",
  "babel.config.js",
  ".babelrc.js",
];

/**
 * Ensure package.json has "type": "module".
 * Returns true if it was added (i.e. it wasn't already there).
 */
export function ensureESModule(root: string): boolean {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return false;

  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    if (pkg.type === "module") return false;

    pkg.type = "module";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename CJS config files (that use `module.exports`) to .cjs
 * to avoid breakage when "type": "module" is added.
 * Returns array of [oldName, newName] pairs that were renamed.
 */
export function renameCJSConfigs(root: string): Array<[string, string]> {
  const renamed: Array<[string, string]> = [];

  for (const fileName of CJS_CONFIG_FILES) {
    const filePath = path.join(root, fileName);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      // Only rename if it actually uses CJS patterns
      if (/\bmodule\.exports\b/.test(content) || /\brequire\s*\(/.test(content)) {
        const newName = fileName.replace(/\.js$/, ".cjs");
        const newPath = path.join(root, newName);
        fs.renameSync(filePath, newPath);
        renamed.push([fileName, newName]);
      }
    } catch {
      // skip unreadable files
    }
  }

  return renamed;
}

// ─── Package Manager Detection ───────────────────────────────────────────────

/**
 * Detect which package manager is used by looking at lock files.
 * Returns the install command string (e.g. "pnpm add -D").
 */
export function detectPackageManager(root: string): string {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm add -D";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn add -D";
  if (fs.existsSync(path.join(root, "bun.lockb"))) return "bun add -D";
  return "npm install -D";
}

/**
 * Detect which package manager name is used (without install args).
 * Returns "pnpm", "yarn", "bun", or "npm".
 */
export function detectPackageManagerName(root: string): string {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

// ─── Vite Config Detection ───────────────────────────────────────────────────

/**
 * Check if a vite.config file exists in the project root.
 */
export function hasViteConfig(root: string): boolean {
  return (
    fs.existsSync(path.join(root, "vite.config.ts")) ||
    fs.existsSync(path.join(root, "vite.config.js")) ||
    fs.existsSync(path.join(root, "vite.config.mjs"))
  );
}

/**
 * Check if the project uses App Router (has an app/ directory).
 */
export function hasAppDir(root: string): boolean {
  return (
    fs.existsSync(path.join(root, "app")) ||
    fs.existsSync(path.join(root, "src", "app"))
  );
}
