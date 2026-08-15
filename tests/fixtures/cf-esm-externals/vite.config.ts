import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";
import { externalizeWorkerFixtureMissingImport } from "./esm-externals-test-plugin";

export default defineConfig({
  plugins: [
    externalizeWorkerFixtureMissingImport(),
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
