import type { RscCacheKeyMode } from "./cache-adapters-virtual.js";

export const VIRTUAL_RSC_PREWARM_CLIENT = "virtual:vinext-rsc-prewarm-client";
export const VIRTUAL_RSC_PREWARM_SERVER = "virtual:vinext-rsc-prewarm-server";

export function generateRscPrewarmClientModule(
  mode: RscCacheKeyMode,
  implementationPath: string,
  hotReload = false,
): string {
  if (mode !== "response-vary") {
    if (!hotReload) return "export {};\n";
    return [
      'import { clearRscPrewarmClientImplementation } from "vinext/shims/rsc-prewarm-client";',
      "clearRscPrewarmClientImplementation();",
      "if (import.meta.hot) import.meta.hot.accept();",
      "",
    ].join("\n");
  }
  return [
    `import * as implementation from ${JSON.stringify(implementationPath)};`,
    'import { registerRscPrewarmClientImplementation } from "vinext/shims/rsc-prewarm-client";',
    `${hotReload ? "const unregister = " : ""}registerRscPrewarmClientImplementation(implementation);`,
    ...(hotReload
      ? [
          "if (import.meta.hot) {",
          "  import.meta.hot.accept();",
          "  import.meta.hot.dispose(unregister);",
          "}",
        ]
      : []),
    "",
  ].join("\n");
}

export function generateRscPrewarmServerModule(
  mode: RscCacheKeyMode,
  implementationPath: string,
  hotReload = false,
): string {
  if (mode !== "response-vary") {
    if (!hotReload) return "export {};\n";
    return [
      'import { clearRscPrewarmServerImplementation } from "vinext/shims/rsc-prewarm-server";',
      "clearRscPrewarmServerImplementation();",
      "if (import.meta.hot) import.meta.hot.accept();",
      "",
    ].join("\n");
  }
  return [
    `import * as implementation from ${JSON.stringify(implementationPath)};`,
    'import { registerRscPrewarmServerImplementation } from "vinext/shims/rsc-prewarm-server";',
    `${hotReload ? "const unregister = " : ""}registerRscPrewarmServerImplementation(implementation);`,
    ...(hotReload
      ? [
          "if (import.meta.hot) {",
          "  import.meta.hot.accept();",
          "  import.meta.hot.dispose(unregister);",
          "}",
        ]
      : []),
    "",
  ].join("\n");
}
