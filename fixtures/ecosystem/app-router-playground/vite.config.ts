import { defineConfig } from "vite";
import nextcompat from "vite-plugin-nextcompat";
import path from "node:path";

/**
 * Vite config for the Next.js App Router Playground running on nextcompat.
 *
 * This replaces next.config.ts — all Next.js features are provided by
 * the vite-plugin-nextcompat plugin.
 *
 * To run: npx vite dev
 * To build: npx vite build
 * To deploy to Cloudflare: npx wrangler deploy
 */
export default defineConfig({
  plugins: [
    // Strip 'use cache' directives (not yet supported, treat as no-op)
    {
      name: "strip-use-cache",
      transform(code, id) {
        if (
          !id.includes("node_modules") &&
          (id.endsWith(".tsx") || id.endsWith(".ts") || id.endsWith(".jsx") || id.endsWith(".js")) &&
          code.includes("'use cache")
        ) {
          // Remove 'use cache', 'use cache: remote', 'use cache: private' directives
          const stripped = code.replace(
            /^[ \t]*['"]use cache(?::\s*\w+)?['"];?\s*$/gm,
            "// [nextcompat] 'use cache' stripped (not yet supported)",
          );
          if (stripped !== code) {
            return { code: stripped, map: null };
          }
        }
        return null;
      },
    },

    // nextcompat plugin (provides all next/* shims, routing, SSR, RSC)
    ...nextcompat(),
  ],

  resolve: {
    alias: {
      // Map #/* imports to the project root (matches tsconfig paths)
      "#": path.resolve(__dirname),
      // server-only is a guard package — resolve to empty module in SSR
      "server-only": path.resolve(__dirname, "server-only-shim.ts"),
    },
  },

  css: {
    postcss: {
      plugins: [],
    },
  },
});
