import { builtinModules } from "node:module";

const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith("node:") ? [name, name.slice(5)] : [name, `node:${name}`],
  ),
);

export const BARE_PACKAGE_SPECIFIER_RE =
  /^(?:(?<scoped>@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+)|(?<unscoped>[A-Za-z0-9_~-][A-Za-z0-9._~-]*))(?:\/[^?#]*)?$/;

/**
 * Extract the npm package name from a bare package specifier.
 *
 * Relative and absolute paths, package imports, URL/virtual schemes, malformed
 * scoped names, and Node builtins are not npm package references.
 */
export function packageNameFromSpecifier(specifier: string): string | null {
  const match = BARE_PACKAGE_SPECIFIER_RE.exec(specifier);
  const packageName = match?.groups?.scoped ?? match?.groups?.unscoped ?? null;
  if (!packageName || BUILTIN_MODULES.has(packageName)) return null;
  return packageName;
}
