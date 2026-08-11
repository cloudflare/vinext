import type { Plugin } from "vite";

const RSC_CSS_VIRTUAL_MODULE_RE = /virtual:vite-rsc\/css\?/;
const RESOURCE_LINK_HREF = '"data-rsc-css-href": href';
const RESOURCE_LINK_PRECEDENCE = "...precedence ? { precedence } : {},";
const GLOBAL_CSS_PRECEDENCE =
  '...precedence ? { precedence: href.includes("/app-global-css-") ? "vite-rsc/client-reference" : precedence } : {},';

/**
 * Keep server-rendered RSC stylesheet resources compatible with React's
 * client-reference CSS preloads.
 *
 * React adds `crossOrigin: ""` when it preinitializes client-reference CSS.
 * Stable global-CSS owner assets also use the client-reference precedence so
 * a stylesheet shared by a Server Component and a Client Component has the
 * same React resource identity on both sides. Otherwise React appends a
 * duplicate link after hydration and the late duplicate can invert the source
 * cascade order.
 */
export function createRscCssResourceCrossOriginPlugin(): Plugin {
  return {
    name: "vinext:rsc-css-resource-crossorigin",
    apply: "build",
    enforce: "post",
    transform: {
      filter: { id: RSC_CSS_VIRTUAL_MODULE_RE },
      handler(code) {
        if (!code.includes(RESOURCE_LINK_HREF) || !code.includes(RESOURCE_LINK_PRECEDENCE)) {
          return null;
        }
        return code
          .replace(RESOURCE_LINK_PRECEDENCE, GLOBAL_CSS_PRECEDENCE)
          .replace(RESOURCE_LINK_HREF, `crossOrigin: "",\n        ${RESOURCE_LINK_HREF}`);
      },
    },
  };
}
