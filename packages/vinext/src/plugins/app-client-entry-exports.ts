import type { ESTree } from "vite";
import { getAstName, parseProgram, scriptParserLanguage } from "./ast-utils.js";

/** Cheap pre-parse gate: every rejected module mentions one of these names. */
export const APP_CLIENT_ENTRY_EXPORT_CANDIDATE_RE =
  /[mM]etadata|generateStaticParams|unstable_instant/;

// Next.js reads no static info from a file whose source matches none of these
// (packages/next/src/build/analysis/get-page-static-info.ts PARSE_PATTERN).
const STATIC_INFO_PARSE_PATTERN =
  /(?<!(_jsx|jsx-))runtime|preferredRegion|getStaticProps|getServerSideProps|generateStaticParams|export const|generateImageMetadata|generateSitemaps|middleware|proxy/;

// The function exports Next.js's static info reads. The last one a module
// declares decides whether generateStaticParams counts.
const STATIC_INFO_FUNCTION_EXPORTS = new Set([
  "getStaticProps",
  "getServerSideProps",
  "generateImageMetadata",
  "generateSitemaps",
  "generateStaticParams",
]);

function createClientMetadataExportMessage(name: string): string {
  return `You are attempting to export "${name}" from a component marked with "use client", which is disallowed. "${name}" must be resolved on the server before the page component is rendered. Keep your page as a Server Component and move Client Component logic to a separate file. Read more: https://nextjs.org/docs/app/api-reference/functions/generate-metadata#why-generatemetadata-is-server-component-only`;
}

function createClientSegmentConfigMessage(name: string, reason: string): string {
  return `Next.js can't recognize the exported \`${name}\` field in route. ${reason}`;
}

function hasUseClientDirective(body: ESTree.Program["body"]): boolean {
  for (const statement of body) {
    if (statement.type !== "ExpressionStatement" || !statement.directive) return false;
    if (statement.directive === "use client") return true;
  }
  return false;
}

/** Ported from get-page-static-info.ts checkExports. */
function exportsGenerateStaticParams(body: ESTree.Program["body"]): boolean {
  let exported = false;
  for (const statement of body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    const name =
      declaration?.type === "FunctionDeclaration" || declaration?.type === "TSDeclareFunction"
        ? getAstName(declaration.id)
        : declaration?.type === "VariableDeclaration" &&
            declaration.declarations[0]?.id.type === "Identifier"
          ? declaration.declarations[0].id.name
          : null;
    if (name && STATIC_INFO_FUNCTION_EXPORTS.has(name)) exported = name === "generateStaticParams";
    for (const specifier of statement.specifiers) {
      if (
        specifier.local.type === "Identifier" &&
        specifier.local.name === "generateStaticParams"
      ) {
        exported = true;
      }
    }
  }
  return exported;
}

/**
 * Whether a module's segment config holds `unstable_instant`: Next.js reads it
 * only from an initialized `export const` (get-page-static-info.ts
 * getAppPageStaticInfo, extract-const-value.ts extractExportedConstValue).
 */
function exportsUnstableInstant(body: ESTree.Program["body"]): boolean {
  return body.some(
    (statement) =>
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration?.type === "VariableDeclaration" &&
      statement.declaration.kind === "const" &&
      statement.declaration.declarations.some(
        (declarator) =>
          declarator.id.type === "Identifier" &&
          declarator.id.name === "unstable_instant" &&
          declarator.init,
      ),
  );
}

/**
 * The top-level names a module binds only as types. TypeScript stripping
 * drops their export specifiers before Next.js's webpack build checks the
 * module.
 */
function getTypeOnlyNames(body: ESTree.Program["body"]): Set<string> {
  const typeNames = new Set<string>();
  const valueNames = new Set<string>();
  for (const node of body) {
    const statement =
      node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        const typeOnly =
          statement.importKind === "type" ||
          (specifier.type === "ImportSpecifier" && specifier.importKind === "type");
        (typeOnly ? typeNames : valueNames).add(specifier.local.name);
      }
    } else if (
      statement.type === "TSTypeAliasDeclaration" ||
      statement.type === "TSInterfaceDeclaration"
    ) {
      typeNames.add(statement.id.name);
    } else if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        if (declarator.id.type === "Identifier") valueNames.add(declarator.id.name);
      }
    } else if (
      statement.type === "FunctionDeclaration" ||
      statement.type === "ClassDeclaration" ||
      statement.type === "TSEnumDeclaration"
    ) {
      const name = getAstName(statement.id);
      if (name) valueNames.add(name);
    }
  }
  for (const name of valueNames) typeNames.delete(name);
  return typeNames;
}

/**
 * The metadata exports Next.js rejects from a client entry
 * (crates/next-custom-transforms/src/transforms/react_server_components.rs
 * assert_invalid_api), by declared or local specifier name. Its webpack build
 * checks a module once TypeScript is stripped, so type-only exports pass.
 */
function getMetadataExports(body: ESTree.Program["body"]): Set<string> {
  const exported = new Set<string>();
  const addName = (name: string | null) => {
    if (name === "metadata" || name === "generateMetadata") exported.add(name);
  };
  const typeOnlyNames = getTypeOnlyNames(body);
  for (const statement of body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration") {
      addName(getAstName(declaration.id));
    } else if (declaration?.type === "VariableDeclaration" && !declaration.declare) {
      for (const declarator of declaration.declarations) addName(getAstName(declarator.id));
    }
    for (const specifier of statement.specifiers) {
      if (specifier.exportKind === "type" || specifier.local.type !== "Identifier") continue;
      if (!statement.source && typeOnlyNames.has(specifier.local.name)) continue;
      addName(specifier.local.name);
    }
  }
  return exported;
}

/**
 * Reject the exports Next.js disallows in a `"use client"` App Router page,
 * layout or route file, where both of its bundlers do. Turbopack builds run
 * Next.js's static info checks, and a stricter segment config check of their
 * own (crates/next-core/src/segment_config.rs) that webpack builds lack.
 * `source` is the file as written, which Next.js's static info reads.
 *
 * Next.js reads static info for the route's file in app/, but checks metadata
 * on the module it resolves, so a symlinked file can get only one of them.
 */
export function validateAppClientEntryExports(
  code: string,
  id: string,
  source = code,
  checks: { metadata: boolean; staticInfo: boolean } = { metadata: true, staticInfo: true },
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

  const messages = checks.metadata
    ? [...getMetadataExports(ast.body)].map(createClientMetadataExportMessage)
    : [];
  if (checks.staticInfo && STATIC_INFO_PARSE_PATTERN.test(source)) {
    if (exportsGenerateStaticParams(ast.body)) {
      messages.push(
        createClientSegmentConfigMessage(
          "generateStaticParams",
          'App pages cannot use both "use client" and export function "generateStaticParams()".',
        ),
      );
    }
    if (exportsUnstableInstant(ast.body)) {
      messages.push(
        createClientSegmentConfigMessage(
          "unstable_instant",
          'App pages cannot export "unstable_instant" from a Client Component module. To use this API, convert this module to a Server Component by removing the "use client" directive.',
        ),
      );
    }
  }
  if (messages.length > 0) throw new Error(messages.join("\n\n"));
}
