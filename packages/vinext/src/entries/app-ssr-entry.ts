import { resolveRuntimeEntryModule } from "./runtime-entry-module.js";

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
 *
 * When `nitroPublicFiles` is set (a Nitro build for a Node-like preset), the
 * default export serves a public file that the RSC handler reached through a
 * rewrite by fetching it back through the Nitro app, whose static handler
 * runs before vinext.
 */
export function generateSsrEntry(
  hasPagesDir = false,
  options: { nitroPublicFiles?: string | null } = {},
): string {
  const entryPath = resolveRuntimeEntryModule("app-ssr-entry");
  const defaultExport = options.nitroPublicFiles
    ? `import __ssrEntry from ${JSON.stringify(entryPath)};
import { resolveNitroStaticFileSignal } from ${JSON.stringify(options.nitroPublicFiles)};
export default {
  async fetch(request) {
    return resolveNitroStaticFileSignal(await __ssrEntry.fetch(request), request);
  },
};`
    : `export { default } from ${JSON.stringify(entryPath)};`;

  return `
export * from ${JSON.stringify(entryPath)};
${defaultExport}
${
  hasPagesDir
    ? `
export {
  __ensureInstrumentation,
  handleApiRoute,
  matchApiRoute,
  matchPageRoute,
  pageRoutes,
  renderPage,
} from "virtual:vinext-server-entry";
`
    : ""
}`;
}
