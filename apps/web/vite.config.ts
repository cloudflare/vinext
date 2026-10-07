import vinext from "vinext";
import { defineConfig } from "vite-plus";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { cloudflare } from "@cloudflare/vite-plugin";
import mdx from "@mdx-js/rollup";
import { responseStoreServiceBinding } from "./cloudflare.config.ts";
import { rehypeHeadingLinks } from "./rehype-heading-links.ts";

export default defineConfig({
  plugins: [
    { ...mdx({ rehypePlugins: [rehypeHeadingLinks] }), enforce: "pre" },
    vinext({
      cache: responseStoreAdapter(),
      images: {
        optimizer: imagesOptimizer(),
      },
    }),
    cloudflare({
      auxiliaryWorkers: [{ config: responseStoreServiceBinding }],
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
