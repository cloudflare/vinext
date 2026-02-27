import { defineConfig } from "vite";
import vinext from "vinext";
import netlify from "@netlify/vite-plugin";

export default defineConfig({
  plugins: [netlify(), vinext()],
});
