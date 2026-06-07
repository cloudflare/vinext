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
import { fileURLToPath } from "node:url";

const VINEXT_SOURCE_SEGMENT = "/packages/vinext/src/";
const VINEXT_SOURCE_ROOT = "packages/vinext/src";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STATIC_HELPER_MODULES = [
  "plugins/ast-utils.ts",
  "routing/file-matcher.ts",
  "routing/utils.ts",
  "entries/pages-entry-helpers.ts",
  "server/cookie-utils.ts",
  "server/worker-utils.ts",
  "shims/font-utils.ts",
  "shims/internal/utils.ts",
  "shims/url-utils.ts",
];

const MANUAL_ALIASES = new Map([
  [
    "compareAppElementsSlotIds",
    { exportName: "compareAppElementsSlotIds", modulePath: "server/app-elements-wire.ts" },
  ],
  ["isRecord", { exportName: "isUnknownRecord", modulePath: "utils/record.ts" }],
]);

const EXPORT_FUNCTION_RE = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/gm;
const EXPORT_VARIABLE_RE =
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*(?:async\s*)?(?:function\b|\([^)]*\)(?:\s*:\s*[^=]+?)?\s*=>|[A-Za-z_$][\w$]*\s*(?:=>|;))/gm;
const EXPORT_NAMED_RE = /^export\s*\{([^}]+)\}\s*(?:from\s*["'][^"']+["'])?\s*;?/gm;

function normalizeFilename(filename) {
  return filename.split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function readExportedFunctionNames(absPath) {
  const source = fs.readFileSync(absPath, "utf-8");
  const exportNames = new Set();
  for (const match of source.matchAll(EXPORT_FUNCTION_RE)) {
    exportNames.add(match[1]);
  }
  for (const match of source.matchAll(EXPORT_VARIABLE_RE)) {
    exportNames.add(match[1]);
  }
  for (const match of source.matchAll(EXPORT_NAMED_RE)) {
    for (const specifier of match[1].split(",")) {
      const cleaned = specifier.trim();
      if (!cleaned || cleaned.startsWith("type ")) continue;
      const [, exportedName] =
        /\bas\s+([A-Za-z_$][\w$]*)$/.exec(cleaned) ?? /^([A-Za-z_$][\w$]*)$/.exec(cleaned) ?? [];
      if (exportedName) exportNames.add(exportedName);
    }
  }
  return Array.from(exportNames);
}

function listUtilsModules(srcRootAbs) {
  const utilsDir = path.join(srcRootAbs, "utils");
  const entries = fs.readdirSync(utilsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `utils/${entry.name}`);
}

function buildSharedUtilities() {
  const srcRootAbs = path.resolve(REPO_ROOT, VINEXT_SOURCE_ROOT);
  const modulePaths = [...listUtilsModules(srcRootAbs), ...STATIC_HELPER_MODULES];
  const shared = new Map(MANUAL_ALIASES);

  for (const modulePath of modulePaths) {
    const absPath = path.join(srcRootAbs, modulePath);
    for (const exportName of readExportedFunctionNames(absPath)) {
      if (!shared.has(exportName)) {
        shared.set(exportName, { exportName, modulePath });
      }
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
        String.raw`\b(?:export\s+)?(?:async\s+)?function\s+(${SHARED_UTILITY_NAMES_PATTERN})\b|\b(?:export\s+)?(?:const|let|var)\s+(${SHARED_UTILITY_NAMES_PATTERN})\s*[^=]*=\s*(?:async\s*)?(?:function\b|\([^)]*\)(?:\s*:\s*[^=]+?)?\s*=>|[A-Za-z_$][\w$]*\s*=>)`,
        "g",
      );

function maskRange(source, start, end) {
  return `${source.slice(0, start)}${" ".repeat(end - start)}${source.slice(end)}`;
}

function maskCommentsAndQuotedStrings(source, options = { scanTemplateBodies: true }) {
  let masked = source;
  let i = 0;
  while (i < masked.length) {
    const current = masked[i];
    const next = masked[i + 1];
    if (current === "/" && next === "/") {
      const end = masked.indexOf("\n", i + 2);
      const rangeEnd = end === -1 ? masked.length : end;
      masked = maskRange(masked, i, rangeEnd);
      i = rangeEnd;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = masked.indexOf("*/", i + 2);
      const rangeEnd = end === -1 ? masked.length : end + 2;
      masked = maskRange(masked, i, rangeEnd);
      i = rangeEnd;
      continue;
    }
    if (current === "`") {
      // Source modules can embed generated source in template strings, so keep
      // those template bodies scannable there. Test files often contain rule
      // fixtures as template strings; mask those like ordinary strings so the
      // lint rule validates the test file itself, not its fixture payloads.
      let end = i + 1;
      while (end < masked.length) {
        if (masked[end] === "\\") {
          end += 2;
          continue;
        }
        if (masked[end] === "`") {
          end += 1;
          break;
        }
        end += 1;
      }
      if (!options.scanTemplateBodies) {
        masked = maskRange(masked, i, end);
      }
      i = end;
      continue;
    }
    if (current === '"' || current === "'") {
      const quote = current;
      let end = i + 1;
      while (end < masked.length) {
        if (masked[end] === "\\") {
          end += 2;
          continue;
        }
        if (masked[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      masked = maskRange(masked, i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return masked;
}

function isCanonicalDefinitionFile(filename, modulePath) {
  return filename.endsWith(`/packages/vinext/src/${modulePath}`);
}

function isVinextSourceFile(filename) {
  return filename.includes(VINEXT_SOURCE_SEGMENT);
}

function isLintedProjectFile(filename) {
  if (isVinextSourceFile(filename)) return true;
  return filename.startsWith(`${normalizeFilename(REPO_ROOT)}/tests/`);
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
        if (!isLintedProjectFile(filename)) return;
        const source = maskCommentsAndQuotedStrings(context.sourceCode.getText(node), {
          scanTemplateBodies: isVinextSourceFile(filename),
        });
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
