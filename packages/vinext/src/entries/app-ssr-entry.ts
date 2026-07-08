import { resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import type { SsrRenderTransport } from "./ssr-render-transport.js";

/**
 * Generate the virtual SSR entry module.
 *
 * This runs in the `ssr` Vite environment. It receives an RSC stream,
 * deserializes it to a React tree, and renders to HTML.
 *
 * When `hasPagesDir` is true (hybrid App + Pages Router project), the SSR
 * entry also re-exports selected Pages server entry hooks from
 * `virtual:vinext-server-entry` so the RSC bundle can access Pages Router
 * route metadata and fallback dispatchers via `import("./ssr/index.js")`.
 */
export function generateSsrEntry(
  hasPagesDir = false,
  ssrRenderTransport: SsrRenderTransport = "web",
): string {
  const entryPath = resolveRuntimeEntryModule(`app-ssr-entry.${ssrRenderTransport}`);

  return `
export * from ${JSON.stringify(entryPath)};
export { default } from ${JSON.stringify(entryPath)};
${
  hasPagesDir
    ? `
export { handleApiRoute, matchApiRoute, matchPageRoute, pageRoutes, renderPage } from "virtual:vinext-server-entry";
`
    : ""
}`;
}
