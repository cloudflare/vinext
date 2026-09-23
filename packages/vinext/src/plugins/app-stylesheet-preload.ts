/**
 * Route App Router client-chunk stylesheets through React's stylesheet
 * resources instead of Vite's preload helper appending them to <head>.
 *
 * Next.js does the same for webpack CSS chunks (`_N_E_STYLE_LOAD` feeding the
 * App Router's `RuntimeStyles` with `precedence`), so a stylesheet loaded by a
 * lazily imported client component is ordered after the Server Component
 * stylesheets React has committed and is deduplicated against them by href.
 * Vite's helper checks the DOM once, when the import starts. During a client
 * render (SSR error-shell recovery, soft navigation) React has not committed
 * the server stylesheets yet, so the helper appends its own copy last and that
 * copy wins the cascade.
 *
 * Only the production preload helper exists in builds, so dev is unaffected.
 * When the App Router runtime has not installed a loader (Pages Router pages in
 * a hybrid build), the helper keeps Vite's DOM insertion.
 */
import type { Plugin } from "vite";
import { APP_STYLESHEET_LOADER_KEY } from "../utils/app-stylesheet-loader.js";

const PRELOAD_HELPER_ID = "\0vite/preload-helper.js";
const LINK_CREATION = 'const link = document.createElement("link");';

/**
 * Insert the loader hand-off ahead of the helper's `<link>` creation. Returns
 * null when Vite's helper no longer has the expected shape.
 */
export function patchPreloadHelperForAppStylesheets(code: string): string | null {
  const index = code.indexOf(LINK_CREATION);
  if (index === -1 || !code.includes("const isCss = ")) return null;
  const handOff =
    "if (isCss) {" +
    ` const vinextLoadStylesheet = globalThis[Symbol.for(${JSON.stringify(APP_STYLESHEET_LOADER_KEY)})];` +
    ' if (typeof vinextLoadStylesheet === "function") return vinextLoadStylesheet(dep, cspNonce);' +
    " }\n";
  return code.slice(0, index) + handOff + code.slice(index);
}

export function createAppStylesheetPreloadPlugin(): Plugin {
  return {
    name: "vinext:app-stylesheet-preload",
    apply: "build",
    applyToEnvironment(environment) {
      return environment.name === "client";
    },
    transform: {
      filter: { id: /^\0vite\/preload-helper\.js$/ },
      handler(code, id) {
        if (id !== PRELOAD_HELPER_ID) return null;
        const patched = patchPreloadHelperForAppStylesheets(code);
        if (patched === null) {
          this.warn(
            "vinext: Vite's preload helper changed shape; App Router client stylesheets fall back to Vite's <head> insertion.",
          );
          return null;
        }
        return { code: patched, map: null };
      },
    },
  };
}
