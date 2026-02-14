import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";
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

    // Shim React canary APIs (ViewTransition, addTransitionType) that don't
    // exist in stable React 19. Provides no-op replacements so the
    // view-transitions page degrades gracefully instead of crashing.
    {
      name: "shim-react-canary",
      resolveId(id) {
        if (id === "virtual:react-with-canary") return "\0virtual:react-with-canary";
      },
      load(id) {
        if (id === "\0virtual:react-with-canary") {
          return `
            export * from "react";
            export { default } from "react";
            import React from "react";
            export const ViewTransition = React.ViewTransition || (({ children }) => children);
            export const addTransitionType = React.addTransitionType || (() => {});
          `;
        }
      },
      transform(code, id) {
        // Rewrite imports from 'react' that reference canary APIs
        if (
          !id.includes("node_modules") &&
          (id.endsWith(".tsx") || id.endsWith(".ts") || id.endsWith(".jsx") || id.endsWith(".js")) &&
          (code.includes("ViewTransition") || code.includes("addTransitionType")) &&
          /from\s+['"]react['"]/.test(code)
        ) {
          // Only rewrite if the import actually destructures ViewTransition or addTransitionType
          const importRegex = /import\s*\{[^}]*(ViewTransition|addTransitionType)[^}]*\}\s*from\s*['"]react['"]/;
          if (importRegex.test(code)) {
            const result = code.replace(
              /from\s*['"]react['"]/g,
              'from "virtual:react-with-canary"',
            );
            if (result !== code) {
              return { code: result, map: null };
            }
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
