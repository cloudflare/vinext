import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config";

// Builds the same host as a Worker, with the asset routing `vinext init` writes.
export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      cloudflare({
        configPath: "./wrangler.cloudflare.jsonc",
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      }),
    ],
  }),
);
