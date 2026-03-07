import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
  ssr: {
    // Force better-auth through Vite's transform pipeline so our next/* aliases
    // work when better-auth/next-js does import("next/headers")
    noExternal: ["better-auth"],
    // Native addon packages must be externalized — bindings uses stack trace
    // introspection that breaks when Vite transforms it (mirrors Next.js serverExternalPackages)
    external: ["better-sqlite3"],
  },
});
