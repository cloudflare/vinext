import { defineConfig } from "vite";
import nextcompat from "vite-plugin-nextcompat";

export default defineConfig({
  plugins: [nextcompat()],
});
