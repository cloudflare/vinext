import { defineConfig } from "vite";
import vinext from "../../../packages/vinext/dist/index.js";

export default defineConfig({
  plugins: [vinext()],
});
