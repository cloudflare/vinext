import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
  ssr: {
    // Force nuqs through Vite's transform pipeline so our next/* aliases work
    noExternal: ["nuqs"],
  },
});
