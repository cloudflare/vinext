/**
 * Shim coverage CLI — compares api-manifest.json against our shim exports
 * and known-gaps.json. Exits non-zero if there are uncovered modules/exports.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkModuleCoverage,
  extractExports,
  type KnownGaps,
} from "../packages/vinext/src/shims/coverage.js";
import { PUBLIC_SHIMS } from "../packages/vinext/src/shims/registry.js";

const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "api-manifest.json");
const gapsPath = path.join(root, "known-gaps.json");
const shimsDir = path.join(root, "packages/vinext/src/shims");

// Load manifest
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

// Load known gaps
const gaps: KnownGaps = JSON.parse(fs.readFileSync(gapsPath, "utf-8"));

// Extract exports from each shim file
const shimExports: Record<string, Set<string>> = {};
for (const [module, shimFile] of Object.entries(PUBLIC_SHIMS)) {
  const fullPath = path.join(shimsDir, shimFile + ".ts");
  const tsxPath = path.join(shimsDir, shimFile + ".tsx");
  const filePath = fs.existsSync(fullPath) ? fullPath : fs.existsSync(tsxPath) ? tsxPath : null;

  if (filePath) {
    const source = fs.readFileSync(filePath, "utf-8");
    const { runtime } = extractExports(source);
    shimExports[module] = runtime;
  }
}

// Check coverage
const result = checkModuleCoverage(manifest, new Set(Object.keys(PUBLIC_SHIMS)), shimExports, gaps);

// Report
console.log(`\nShim Coverage Report (next@${manifest.version})`);
console.log(`${"─".repeat(50)}`);
console.log(`Covered modules: ${result.coveredModules.length}`);
console.log(`Gapped modules:  ${result.gappedModules.length}`);
console.log(`Missing modules: ${result.missingModules.length}`);
console.log(`Modules with missing exports: ${Object.keys(result.missingExports).length}`);

if (result.missingModules.length > 0) {
  console.log(`\nMissing modules (not in registry or known-gaps):`);
  for (const mod of result.missingModules) {
    console.log(`  - ${mod}`);
  }
}

if (Object.keys(result.missingExports).length > 0) {
  console.log(`\nMissing exports:`);
  for (const [mod, exports] of Object.entries(result.missingExports)) {
    console.log(`  ${mod}: ${exports.join(", ")}`);
  }
}

if (!result.passed) {
  console.log(`\nCoverage check FAILED`);
  process.exit(1);
} else {
  console.log(`\nCoverage check PASSED`);
}
