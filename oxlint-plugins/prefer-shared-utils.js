/**
 * Oxlint JS plugin: prefer-shared-utils.
 *
 * Reports local redefinitions of shared helpers. The protected helper list is
 * derived from the actual helper modules at lint startup, so adding a new
 * exported helper to those modules automatically makes future hand-rolled
 * copies lint failures.
 *
 * The rule also scans raw source text, not only AST function nodes, because
 * vinext contains generated source embedded in template strings.
 */
import fs from "node:fs";
import path from "node:path";

const VINEXT_SOURCE_SEGMENT = "/packages/vinext/src/";
const VINEXT_SOURCE_ROOT = "packages/vinext/src";

const STATIC_HELPER_MODULES = [
  "plugins/ast-utils.ts",
  "routing/utils.ts",
  "server/cookie-utils.ts",
  "server/worker-utils.ts",
  "shims/font-utils.ts",
  "shims/internal/utils.ts",
  "shims/url-utils.ts",
];

const MANUAL_ALIASES = new Map([
  ["isRecord", { exportName: "isUnknownRecord", modulePath: "utils/record.ts" }],
]);

const EXPORT_FUNCTION_RE = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/gm;

function normalizeFilename(filename) {
  return filename.split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function readExportedFunctionNames(absPath) {
  const source = fs.readFileSync(absPath, "utf-8");
  return Array.from(source.matchAll(EXPORT_FUNCTION_RE), (match) => match[1]);
}

function listUtilsModules(srcRootAbs) {
  const utilsDir = path.join(srcRootAbs, "utils");
  const entries = fs.readdirSync(utilsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `utils/${entry.name}`);
}

function buildSharedUtilities() {
  const srcRootAbs = path.resolve(process.cwd(), VINEXT_SOURCE_ROOT);
  const modulePaths = [...listUtilsModules(srcRootAbs), ...STATIC_HELPER_MODULES];
  const shared = new Map(MANUAL_ALIASES);

  for (const modulePath of modulePaths) {
    const absPath = path.join(srcRootAbs, modulePath);
    for (const exportName of readExportedFunctionNames(absPath)) {
      shared.set(exportName, { exportName, modulePath });
    }
  }

  return shared;
}

const SHARED_UTILS = buildSharedUtilities();
const SHARED_UTILITY_NAMES_PATTERN = Array.from(SHARED_UTILS.keys()).map(escapeRegExp).join("|");
const SHARED_UTILITY_DECLARATION =
  SHARED_UTILITY_NAMES_PATTERN === ""
    ? null
    : new RegExp(
        String.raw`\b(?:export\s+)?(?:async\s+)?function\s+(${SHARED_UTILITY_NAMES_PATTERN})\b|\b(?:const|let|var)\s+(${SHARED_UTILITY_NAMES_PATTERN})\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)`,
        "g",
      );

function isCanonicalDefinitionFile(filename, modulePath) {
  return filename.endsWith(`/packages/vinext/src/${modulePath}`);
}

function reportIfSharedUtility(context, filename, node, name) {
  const utility = SHARED_UTILS.get(name);
  if (!utility || isCanonicalDefinitionFile(filename, utility.modulePath)) return;

  context.report({
    node,
    message: `Use shared ${utility.exportName} from packages/vinext/src/${utility.modulePath} instead of redefining ${name}.`,
  });
}

const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Prefer canonical vinext utility helpers over local redefinitions.",
    },
  },
  createOnce(context) {
    return {
      Program(node) {
        if (!SHARED_UTILITY_DECLARATION) return;
        const filename = normalizeFilename(context.filename);
        if (!filename.includes(VINEXT_SOURCE_SEGMENT)) return;
        const source = context.sourceCode.getText(node);
        const reported = new Set();
        for (const match of source.matchAll(SHARED_UTILITY_DECLARATION)) {
          const name = match[1] ?? match[2];
          if (typeof name !== "string" || reported.has(name)) continue;
          reported.add(name);
          reportIfSharedUtility(context, filename, node, name);
        }
      },
    };
  },
};

export default {
  meta: { name: "vinext-utils" },
  rules: { "prefer-shared-utils": rule },
};
