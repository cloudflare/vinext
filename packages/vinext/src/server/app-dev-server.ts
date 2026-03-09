/**
 * App Router dev server handler.
 *
 * Entry-point generators have been extracted into packages/vinext/src/entries/.
 * This module re-exports them for backward compatibility.
 */

export type { AppRouterConfig } from "../entries/app-rsc-entry.js";
export { generateRscEntry } from "../entries/app-rsc-entry.js";
export { generateSsrEntry } from "../entries/app-ssr-entry.js";
export { generateBrowserEntry } from "../entries/app-browser-entry.js";
