import { defineConfig } from "vite-plus";
import vinext from "../../../packages/vinext/dist/index.js";
import { httpStageCacheAdapter } from "./http-stage-cache";

export default defineConfig({
  build: { manifest: true },
  plugins: [
    vinext({ cache: { cdn: httpStageCacheAdapter() } }),
    { name: "independent-http-stage-host" },
  ],
});
