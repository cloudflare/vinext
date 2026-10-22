// Global names shared by server-emitted inline scripts and the browser runtime.
// Kept in a leaf module so SSR does not load browser runtime modules for them.
// Lives in client/ because the Pages Router client bootstrap loads
// navigation-runtime, and that graph must not pull in server/ modules.

export const RSC_FORM_STATE_GLOBAL = "__VINEXT_RSC_FORM_STATE__";
export const NAVIGATION_RUNTIME_SYMBOL_DESCRIPTION = "vinext.navigationRuntime";
// The URL of the App Router client reference registry chunk, which the browser
// imports on its first client reference (see plugins/rsc-client-reference-loaders.ts).
export const CLIENT_REFERENCE_REGISTRY_GLOBAL = "__VINEXT_CLIENT_REFERENCE_REGISTRY__";
