import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import mdx from "@mdx-js/rollup";
import { remarkCodeHike, recmaCodeHike, type CodeHikeConfig } from "codehike/mdx";
import path from "node:path";

const codeHikeConfig: CodeHikeConfig = {
  components: { code: "MyCode", inlineCode: "MyInlineCode" },
};

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

    // MDX support with CodeHike remark/recma plugins — transforms .mdx files
    // into React components and processes !!col directives, code annotations, etc.
    mdx({
      remarkPlugins: [[remarkCodeHike, codeHikeConfig]],
      recmaPlugins: [[recmaCodeHike, codeHikeConfig]],
    }),

    // vinext plugin (provides all next/* shims, routing, SSR, RSC).
    // @vitejs/plugin-rsc is auto-registered when app/ is detected.
    vinext(),

    // Cloudflare Workers plugin — builds for workerd runtime.
    // The worker entry runs in the RSC environment, with SSR as a child.
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
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
