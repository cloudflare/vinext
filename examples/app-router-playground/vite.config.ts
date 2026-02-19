import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";
import { cloudflare } from "@cloudflare/vite-plugin";
import mdx from "@mdx-js/rollup";
import path from "node:path";

/**
 * Vite config for the Next.js App Router Playground running on vinext.
 *
 * This replaces next.config.ts — all Next.js features are provided by
 * the vinext plugin + @vitejs/plugin-rsc for RSC support.
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
            "// [vinext] 'use cache' stripped (not yet supported)",
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

    // vinext plugin (provides all next/* shims, routing, SSR, RSC)
    ...vinext(),

    // RSC plugin — handles "use client" / "use server" directives,
    // multi-environment builds, RSC stream serialization
    rsc({
      entries: {
        rsc: "virtual:vinext-rsc-entry",
        ssr: "virtual:vinext-app-ssr-entry",
        client: "virtual:vinext-app-browser-entry",
      },
    }),

    // Cloudflare Workers plugin — builds for workerd runtime
    cloudflare({
      viteEnvironment: {
        childEnvironments: ["rsc", "ssr"],
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

  // Use postcss.config.js for Tailwind CSS processing
  // (Do NOT override with empty plugins array)
});
