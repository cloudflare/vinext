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
      // loadModuleDevProxy defaults to false — Worker calls RSC/SSR via
      // __VITE_ENVIRONMENT_RUNNER_IMPORT__ directly inside the same workerd
      // isolate (no Node.js RPC hop). This works because childEnvironments
      // puts all module runners in the same Durable Object.
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
