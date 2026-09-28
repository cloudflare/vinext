/**
 * Global registry key for the App Router client stylesheet loader.
 *
 * The production preload helper (patched by `plugins/app-stylesheet-preload.ts`)
 * hands client-chunk stylesheets to the function stored under this key, and the
 * App Router browser runtime (`server/app-browser-stylesheets.ts`) installs it.
 * Kept in a dependency-free module so the Node-side plugin and the browser
 * runtime share one spelling.
 */
export const APP_STYLESHEET_LOADER_KEY = "vinext.appStylesheetLoader";
