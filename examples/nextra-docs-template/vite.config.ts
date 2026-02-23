import { defineConfig } from "vite";
import vinext from "vinext";
import mdx from "@mdx-js/rollup";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    // MDX support — compiles .mdx files into React components
    mdx(),

    // vinext plugin (provides all next/* shims, routing, SSR, RSC)
    vinext(),

    // Cloudflare Workers plugin — builds for workerd runtime
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
