import fs from "node:fs";
import type { ApiManifest } from "./extract-nextjs-api.js";

export interface ManifestDiff {
  added: Record<string, string[]>; // new exports per module
  removed: Record<string, string[]>; // removed exports per module
  newModules: string[]; // entirely new modules
  removedModules: string[]; // entirely removed modules
}

/**
 * Load and parse a manifest JSON file.
 */
export function loadManifest(filePath: string): ApiManifest {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as ApiManifest;
}

/**
 * Diff two manifests. Returns added/removed exports and modules.
 */
export function diffManifests(oldManifest: ApiManifest, newManifest: ApiManifest): ManifestDiff {
  const oldModules = new Set(Object.keys(oldManifest.modules));
  const newModules = new Set(Object.keys(newManifest.modules));

  const newModulesList: string[] = [];
  const removedModulesList: string[] = [];
  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};

  // Find entirely new modules
  for (const mod of newModules) {
    if (!oldModules.has(mod)) {
      newModulesList.push(mod);
    }
  }

  // Find entirely removed modules
  for (const mod of oldModules) {
    if (!newModules.has(mod)) {
      removedModulesList.push(mod);
    }
  }

  // For modules that exist in both, find added/removed exports
  for (const mod of newModules) {
    if (!oldModules.has(mod)) continue;
    const oldExports = new Set(oldManifest.modules[mod]);
    const newExports = new Set(newManifest.modules[mod]);

    const addedExports: string[] = [];
    for (const exp of newExports) {
      if (!oldExports.has(exp)) {
        addedExports.push(exp);
      }
    }
    if (addedExports.length > 0) {
      added[mod] = addedExports.sort();
    }

    const removedExports: string[] = [];
    for (const exp of oldExports) {
      if (!newExports.has(exp)) {
        removedExports.push(exp);
      }
    }
    if (removedExports.length > 0) {
      removed[mod] = removedExports.sort();
    }
  }

  return {
    added,
    removed,
    newModules: newModulesList.sort(),
    removedModules: removedModulesList.sort(),
  };
}

/**
 * Format a diff for human-readable output.
 */
function formatDiff(diff: ManifestDiff, oldVersion: string, newVersion: string): string {
  const lines: string[] = [];
  lines.push(`API diff: next@${oldVersion} → next@${newVersion}`);
  lines.push("");

  const isEmpty =
    diff.newModules.length === 0 &&
    diff.removedModules.length === 0 &&
    Object.keys(diff.added).length === 0 &&
    Object.keys(diff.removed).length === 0;

  if (isEmpty) {
    lines.push("No changes.");
    return lines.join("\n");
  }

  if (diff.newModules.length > 0) {
    lines.push("New modules:");
    for (const mod of diff.newModules) {
      lines.push(`  + ${mod}`);
    }
    lines.push("");
  }

  if (diff.removedModules.length > 0) {
    lines.push("Removed modules:");
    for (const mod of diff.removedModules) {
      lines.push(`  - ${mod}`);
    }
    lines.push("");
  }

  if (Object.keys(diff.added).length > 0) {
    lines.push("Added exports:");
    for (const [mod, exports] of Object.entries(diff.added).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      for (const exp of exports) {
        lines.push(`  + ${mod}.${exp}`);
      }
    }
    lines.push("");
  }

  if (Object.keys(diff.removed).length > 0) {
    lines.push("Removed exports:");
    for (const [mod, exports] of Object.entries(diff.removed).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      for (const exp of exports) {
        lines.push(`  - ${mod}.${exp}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// CLI entry
if (process.argv[1] === import.meta.filename) {
  const oldPath = process.argv[2];
  const newPath = process.argv[3];

  if (!oldPath || !newPath) {
    console.error("Usage: tsx scripts/diff-nextjs-api.ts <old.json> <new.json>");
    process.exit(1);
  }

  const oldManifest = loadManifest(oldPath);
  const newManifest = loadManifest(newPath);
  const diff = diffManifests(oldManifest, newManifest);
  console.log(formatDiff(diff, oldManifest.version, newManifest.version));
}
