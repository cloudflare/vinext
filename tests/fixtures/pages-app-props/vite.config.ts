import { defineConfig } from "vite-plus";
import vinext from "../../../packages/vinext/src/index";

export default defineConfig({
  plugins: [vinext({ disableAppRouter: true })],
});
