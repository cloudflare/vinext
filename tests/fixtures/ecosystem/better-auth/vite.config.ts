import { defineConfig } from "vite-plus";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
  ssr: {
    // Native addon packages must be externalized — bindings uses stack trace
    // introspection that breaks when Vite transforms it (mirrors Next.js serverExternalPackages).
    // vinext sets `noExternal: true` globally, so only explicit externals need listing here.
    external: ["better-sqlite3"],
  },
});
