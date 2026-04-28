import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

export function resolveSwcHelperFromNext(projectRoot: string, specifier: string): string | null {
  if (!specifier.startsWith("@swc/helpers/")) return null;

  const projectRequire = createRequire(path.join(projectRoot, "package.json"));

  try {
    const nextPackageJson = projectRequire.resolve("next/package.json");
    const nextRequire = createRequire(nextPackageJson);
    return nextRequire.resolve(specifier);
  } catch {}

  try {
    return projectRequire.resolve(specifier);
  } catch {
    return null;
  }
}

export function createSwcHelpersResolverPlugin(getRoot: () => string): Plugin {
  return {
    name: "vinext:swc-helpers-resolver",
    enforce: "pre",

    resolveId(source) {
      return resolveSwcHelperFromNext(getRoot(), source);
    },
  };
}
