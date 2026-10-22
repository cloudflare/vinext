import { defineConfig } from "vite-plus";
import vinext from "vinext";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [vinext(), nitro()],
});
