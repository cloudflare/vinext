import type { RscCacheKeyMode } from "./cache-adapters-virtual.js";

export const VIRTUAL_RSC_PREWARM_CLIENT = "virtual:vinext-rsc-prewarm-client";
export const VIRTUAL_RSC_PREWARM_SERVER = "virtual:vinext-rsc-prewarm-server";

export function generateRscPrewarmClientModule(
  mode: RscCacheKeyMode,
  implementationPath: string,
): string {
  if (mode !== "response-vary") return "export {};\n";
  return [
    `import * as implementation from ${JSON.stringify(implementationPath)};`,
    'import { registerRscPrewarmClientImplementation } from "vinext/shims/rsc-prewarm-client";',
    "registerRscPrewarmClientImplementation(implementation);",
    "",
  ].join("\n");
}

export function generateRscPrewarmServerModule(
  mode: RscCacheKeyMode,
  implementationPath: string,
): string {
  if (mode !== "response-vary") return "export {};\n";
  return [
    `import * as implementation from ${JSON.stringify(implementationPath)};`,
    'import { registerRscPrewarmServerImplementation } from "vinext/shims/rsc-prewarm-server";',
    "registerRscPrewarmServerImplementation(implementation);",
    "",
  ].join("\n");
}
