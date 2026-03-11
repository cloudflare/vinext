/**
 * Shim coverage checker — compares the Next.js API manifest against
 * vinext's shim implementations and a known-gaps allowlist.
 *
 * Used by `scripts/check-shim-coverage.ts` (CI gate) and unit tests.
 */

export interface KnownGaps {
  [module: string]: {
    exports: string[]; // ["*"] means skip entire module, or specific export names
    status: "wont-fix" | "stub" | "planned";
    reason: string;
  };
}

export interface CoverageResult {
  passed: boolean;
  missingModules: string[]; // In manifest but not in registry or gaps
  missingExports: Record<string, string[]>; // Per-module missing exports
  coveredModules: string[]; // Successfully covered
  gappedModules: string[]; // Intentionally skipped
}

/**
 * Extract exported names from a TypeScript/JavaScript source file.
 * Uses regex-based parsing (not AST) for simplicity.
 */
export function extractExports(source: string): {
  runtime: Set<string>;
  types: Set<string>;
} {
  const runtime = new Set<string>();
  const types = new Set<string>();

  // export function X / export async function X
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
    runtime.add(m[1]);
  }

  // export const/let/var X
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) {
    runtime.add(m[1]);
  }

  // export class X
  for (const m of source.matchAll(/export\s+class\s+(\w+)/g)) {
    runtime.add(m[1]);
  }

  // export enum X
  for (const m of source.matchAll(/export\s+enum\s+(\w+)/g)) {
    runtime.add(m[1]);
  }

  // export default (treat as "default")
  if (/export\s+default\s/.test(source)) {
    runtime.add("default");
  }

  // export { X, Y as Z } — adds X and Z (the exported name)
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    const items = m[1].split(",");
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/\w+\s+as\s+(\w+)/);
      const name = asMatch ? asMatch[1] : trimmed.split(/\s/)[0];
      // Check if it's a type export: export { type X }
      if (trimmed.startsWith("type ")) {
        types.add(name);
      } else {
        runtime.add(name);
      }
    }
  }

  // export type X / export interface X
  for (const m of source.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)) {
    types.add(m[1]);
  }

  return { runtime, types };
}

/**
 * Check coverage of manifest exports against shim implementations.
 */
export function checkModuleCoverage(
  manifest: { modules: Record<string, string[]> },
  registryKeys: Set<string>, // keys from PUBLIC_SHIMS
  shimExports: Record<string, Set<string>>, // module -> exported names from shim file
  gaps: KnownGaps,
): CoverageResult {
  const missingModules: string[] = [];
  const missingExports: Record<string, string[]> = {};
  const coveredModules: string[] = [];
  const gappedModules: string[] = [];

  for (const [module, exports] of Object.entries(manifest.modules)) {
    // Check if entirely gapped
    if (gaps[module]?.exports.includes("*")) {
      gappedModules.push(module);
      continue;
    }

    // Check if in registry
    if (!registryKeys.has(module)) {
      missingModules.push(module);
      continue;
    }

    // Check individual exports
    const shimSet = shimExports[module] || new Set();
    const gapExports = new Set(gaps[module]?.exports || []);
    const missing: string[] = [];

    for (const exp of exports) {
      if (exp === "__esModule") continue; // skip internals
      if (gapExports.has(exp)) continue; // intentionally skipped
      if (!shimSet.has(exp)) {
        missing.push(exp);
      }
    }

    if (missing.length > 0) {
      missingExports[module] = missing.sort();
    } else {
      coveredModules.push(module);
    }
  }

  return {
    passed: missingModules.length === 0 && Object.keys(missingExports).length === 0,
    missingModules: missingModules.sort(),
    missingExports,
    coveredModules: coveredModules.sort(),
    gappedModules: gappedModules.sort(),
  };
}
