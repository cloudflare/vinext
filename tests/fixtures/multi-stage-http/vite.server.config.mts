import { defineConfig } from "vite-plus";
import vinext from "../../../packages/vinext/dist/index.js";
import { httpStageCacheAdapter } from "./http-stage-cache";

export default defineConfig({
  build: {
    emptyOutDir: true,
    manifest: true,
    outDir: "dist/server",
    ssr: "virtual:vinext-server-entry",
  },
  plugins: [
    vinext({ cache: { cdn: httpStageCacheAdapter() } }),
    { name: "independent-http-stage-host" },
  ],
});
