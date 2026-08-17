// This isolated E2E fixture is not a workspace package. Resolve both plugins
// from installed workspace sources so the checked-in node_modules directory
// can contain only the two upstream package-export fixtures.
import { cloudflare } from "../../../../fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs";
import vinext from "../../../../../packages/vinext/src/index.js";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vinext({ appDir: import.meta.dirname }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
