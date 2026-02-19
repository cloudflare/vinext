import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
  ssr: {
    // Force better-auth through Vite's transform pipeline so our next/* aliases
    // work when better-auth/next-js does import("next/headers")
    noExternal: ["better-auth"],
  },
});
