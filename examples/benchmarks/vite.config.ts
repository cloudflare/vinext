import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { originCdnAdapter } from "@vinext/cloudflare/cache/origin-cdn-adapter";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    vinext({ cache: { cdn: originCdnAdapter() } }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
    tailwindcss(),
  ],
});
