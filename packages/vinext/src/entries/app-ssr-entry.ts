import { resolveRuntimeEntryModule } from "./runtime-entry-module.js";

/**
 * Generate the virtual SSR entry module.
 *
 * This runs in the `ssr` Vite environment. It receives an RSC stream,
 * deserializes it to a React tree, and renders to HTML.
 *
 * When `hasPagesDir` is true (hybrid App + Pages Router project), the SSR
 * entry also re-exports `pageRoutes` from `virtual:vinext-server-entry` so
 * that the Cloudflare Workers RSC bundle can access Pages Router route
 * metadata (including `getStaticPaths`) via `import("./ssr/index.js")`.
 */
export function generateSsrEntry(hasPagesDir = false): string {
  const entryPath = resolveRuntimeEntryModule("app-ssr-entry");

  return `
export * from ${JSON.stringify(entryPath)};
export { default } from ${JSON.stringify(entryPath)};
${
  hasPagesDir
    ? `
export { pageRoutes, renderPage } from "virtual:vinext-server-entry";
`
    : ""
}`;
}
