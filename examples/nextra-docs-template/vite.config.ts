import { defineConfig } from "vite-plus";
import vinext from "vinext";
import mdx from "@mdx-js/rollup";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";

export default defineConfig({
  plugins: [
    // MDX support — compiles .mdx files into React components
    mdx(),

    // vinext plugin (provides all next/* shims, routing, SSR, RSC)
    vinext({ cache: { cdn: cdnAdapter({ mode: "data-cache" }) } }),

    // Cloudflare Workers plugin — builds for workerd runtime
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
