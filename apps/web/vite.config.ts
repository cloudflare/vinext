import vinext from "vinext";
import { defineConfig } from "vite";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { imageAdapter } from "@vinext/cloudflare/images/images-optimizer";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext({
      cache: {
        data: kvDataAdapter(),
      },
      images: {
        optimizer: imageAdapter(),
      },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
