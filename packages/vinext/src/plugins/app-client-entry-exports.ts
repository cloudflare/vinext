import type { ESTree } from "vite";
import { getAstName, parseProgram, scriptParserLanguage } from "./ast-utils.js";

/**
 * Which checks Next.js applies to an App Router entry file: page, layout and
 * route files get both, a default file only the segment config check.
 */
export type AppClientEntryKind = "entry" | "default";

/** Cheap pre-parse gate: every rejected module mentions one of these names. */
export const APP_CLIENT_ENTRY_EXPORT_CANDIDATE_RE =
  /[mM]etadata|generateStaticParams|unstable_instant/;

function createClientMetadataExportMessage(name: string): string {
  return `You are attempting to export "${name}" from a component marked with "use client", which is disallowed. "${name}" must be resolved on the server before the page component is rendered. Keep your page as a Server Component and move Client Component logic to a separate file. Read more: https://nextjs.org/docs/app/api-reference/functions/generate-metadata#why-generatemetadata-is-server-component-only`;
}

// Segment config exports Next.js rejects from a client entry, by exported name.
const CLIENT_SEGMENT_CONFIG_ERRORS = new Map([
  [
    "generateStaticParams",
    'App pages cannot use both "use client" and export function "generateStaticParams()".',
  ],
  [
    "unstable_instant",
    'App pages cannot export "unstable_instant" from a Client Component module. To use this API, convert this module to a Server Component by removing the "use client" directive.',
  ],
]);

function createClientSegmentConfigMessage(name: string): string {
  return `Next.js can't recognize the exported \`${name}\` field in route. ${CLIENT_SEGMENT_CONFIG_ERRORS.get(name)}`;
}

function hasUseClientDirective(body: ESTree.Program["body"]): boolean {
  for (const statement of body) {
    if (statement.type !== "ExpressionStatement" || !statement.directive) return false;
    if (statement.directive === "use client") return true;
  }
  return false;
}

/**
 * Reject the exports Next.js disallows in a `"use client"` App Router entry
 * file. Mirrors Next.js:
 * - crates/next-custom-transforms/src/transforms/react_server_components.rs
 *   (assert_invalid_api): `metadata` / `generateMetadata` in page, layout and
 *   route files, matched by declared or local specifier name.
 * - crates/next-core/src/segment_config.rs (parse_segment_config_from_source):
 *   `generateStaticParams` and `unstable_instant` in page, layout, default
 *   and route files, matched by exported name.
 */
export function validateAppClientEntryExports(
  code: string,
  id: string,
  kind: AppClientEntryKind,
): void {
  if (!code.includes("use client") || !APP_CLIENT_ENTRY_EXPORT_CANDIDATE_RE.test(code)) return;
  const lang = scriptParserLanguage(id);
  if (!lang) return;
  let ast: ESTree.Program;
  try {
    ast = parseProgram(code, { lang });
  } catch {
    return;
  }
  if (!hasUseClientDirective(ast.body)) return;

  const metadataExports = new Set<string>();
  const segmentConfigExports = new Set<string>();
  const addSegmentConfigName = (name: string | null) => {
    if (name && CLIENT_SEGMENT_CONFIG_ERRORS.has(name)) segmentConfigExports.add(name);
  };
  const addDeclaredName = (name: string | null) => {
    if (name === "metadata" || name === "generateMetadata") metadataExports.add(name);
    addSegmentConfigName(name);
  };

  for (const statement of ast.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration") {
      addDeclaredName(getAstName(declaration.id));
    } else if (declaration?.type === "VariableDeclaration" && !declaration.declare) {
      for (const declarator of declaration.declarations) {
        addDeclaredName(getAstName(declarator.id));
      }
    } else if (declaration?.type === "ClassDeclaration") {
      // Only the segment config check sees class exports.
      addSegmentConfigName(getAstName(declaration.id));
    }
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === "type") continue;
      const localName = getAstName(specifier.local);
      if (localName === "metadata" || localName === "generateMetadata") {
        metadataExports.add(localName);
      }
      addSegmentConfigName(getAstName(specifier.exported));
    }
  }

  const messages =
    kind === "entry" ? [...metadataExports].map(createClientMetadataExportMessage) : [];
  for (const name of CLIENT_SEGMENT_CONFIG_ERRORS.keys()) {
    if (segmentConfigExports.has(name)) messages.push(createClientSegmentConfigMessage(name));
  }
  if (messages.length > 0) throw new Error(messages.join("\n\n"));
}
