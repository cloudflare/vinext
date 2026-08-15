// This isolated E2E fixture is not a workspace package. Resolve both plugins
// from installed workspace sources so clean typechecking does not depend on
// the temporary node_modules link used while the fixture runs.
import { cloudflare } from "../../../../fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs";
import vinext from "../../../../../packages/vinext/src/index.js";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vinext({ appDir: import.meta.dirname }),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
