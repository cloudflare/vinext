import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

// next-intl's playground switches routing and next.config options on
// NEXT_PUBLIC_USE_CASE. Each use case builds into its own directory so the
// e2e projects can build and preview them side by side.
const useCase = process.env.NEXT_PUBLIC_USE_CASE;
const outputRoot = useCase && useCase !== "main" ? `.vinext/${useCase}` : "dist";

export default defineConfig({
  plugins: [
    vinext({
      clientOutDir: `${outputRoot}/client`,
      rscOutDir: `${outputRoot}/server`,
      ssrOutDir: `${outputRoot}/server/ssr`,
    }),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
  // The domains use cases browse example.de, never.example.com, etc., mapped
  // to the preview server.
  preview: { allowedHosts: true },
});
