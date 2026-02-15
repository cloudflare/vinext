import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    rsc({
      entries: {
        rsc: "virtual:vinext-rsc-entry",
        ssr: "virtual:vinext-app-ssr-entry",
        client: "virtual:vinext-app-browser-entry",
      },
      // In dev: RSC and SSR run on Node.js, Worker calls via RPC.
      // In build: This flag is ignored — cross-env imports become static import() calls.
      loadModuleDevProxy: true,
    }),
    cloudflare({
      // Link RSC/SSR as child environments so they're built with workerd
      // conditions and bundled into the Worker output.
      viteEnvironment: {
        childEnvironments: ["rsc", "ssr"],
      },
    }),
  ],
});
