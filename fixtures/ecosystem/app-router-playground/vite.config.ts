import { defineConfig } from "vite";
import nextcompat from "vite-plugin-nextcompat";
import rsc from "@vitejs/plugin-rsc";
import mdx from "@mdx-js/rollup";
import path from "node:path";

/**
 * Vite config for the Next.js App Router Playground running on nextcompat.
 *
 * This replaces next.config.ts — all Next.js features are provided by
 * the vite-plugin-nextcompat plugin + @vitejs/plugin-rsc for RSC support.
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

    // MDX support — transforms .mdx files into React components
    mdx(),

    // nextcompat plugin (provides all next/* shims, routing, SSR, RSC)
    ...nextcompat(),

    // RSC plugin — handles "use client" / "use server" directives,
    // multi-environment builds, RSC stream serialization
    rsc({
      entries: {
        rsc: "virtual:nextcompat-rsc-entry",
        ssr: "virtual:nextcompat-app-ssr-entry",
        client: "virtual:nextcompat-app-browser-entry",
      },
    }),
  ],

  resolve: {
    alias: {
      // Map #/* imports to the project root (matches tsconfig paths)
      "#": path.resolve(__dirname),
      // Map bare 'app/' imports (tsconfig baseUrl: ".")
      "app": path.resolve(__dirname, "app"),
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
