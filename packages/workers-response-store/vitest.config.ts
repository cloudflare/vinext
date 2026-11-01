import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 10_000,
    testTimeout: 40_000,
  },
});
