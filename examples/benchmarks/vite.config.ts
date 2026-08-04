import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    vinext({ cache: { cdn: cdnAdapter({ mode: "data-cache" }) } }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
    tailwindcss(),
  ],
});
