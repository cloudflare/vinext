import { defineConfig } from "vite";
import vinext from "vinext";
import mdx from "fumadocs-mdx/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import * as MdxConfig from "./source.config";

export default defineConfig({
  optimizeDeps: {
    include: [
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-dom",
      "react-dom/client",
    ],
    // exclude: ["fumadocs-core", "fumadocs-ui"],
  },
  // ssr: {
  //   noExternal: ["fumadocs-ui", "fumadocs-core"],
  // },
  plugins: [
    // MDX support — compiles .mdx files into React components
    mdx(MdxConfig),

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
