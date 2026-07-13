import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
