import type { Plugin } from "vite";

const RSC_CSS_VIRTUAL_MODULE_RE = /virtual:vite-rsc\/css\?/;
const RESOURCE_LINK_HREF_RE = /(["']data-rsc-css-href["']\s*:\s*[A-Za-z_$][\w$]*)/;

export function addRscCssResourceCrossOrigin(code: string): string {
  if (!RESOURCE_LINK_HREF_RE.test(code)) {
    throw new Error(
      "@vitejs/plugin-rsc changed its CSS resource module shape; vinext could not add crossOrigin",
    );
  }
  return code.replace(RESOURCE_LINK_HREF_RE, `crossOrigin: "",\n        $1`);
}

/**
 * Keep server-rendered RSC stylesheet resources compatible with React's
 * client-reference CSS preloads.
 *
 * React adds `crossOrigin: ""` when it preinitializes client-reference CSS.
 * Global-owner duplicates are reconciled by the browser runtime. Keeping all
 * server resources in their declared importer precedence is important: React
 * groups links by precedence, so assigning globals to a separate group would
 * move a later global stylesheet ahead of an earlier CSS module.
 */
export function createRscCssResourceCrossOriginPlugin(): Plugin {
  return {
    name: "vinext:rsc-css-resource-crossorigin",
    apply: "build",
    enforce: "post",
    transform: {
      filter: { id: RSC_CSS_VIRTUAL_MODULE_RE },
      handler(code) {
        return addRscCssResourceCrossOrigin(code);
      },
    },
  };
}
