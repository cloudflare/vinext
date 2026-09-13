import { defineConfig, type Plugin } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

function simulateLegacyWorkerdModuleIdentity(): Plugin {
  return {
    name: "cf-app-basic:legacy-workerd-module-identity",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      if (this.environment.name !== "ssr" || this.environment.config.build.write === false) return;

      const chunk = Object.values(bundle).find(
        (output) =>
          output.type === "chunk" &&
          output.moduleIds.some((id) =>
            id.replaceAll("\\", "/").endsWith("/node_modules/module-identity-dependency/index.js"),
          ),
      );
      if (!chunk || chunk.type !== "chunk") {
        this.error("Expected the module identity chunk in the final SSR bundle");
      }

      // The Workerd version from #3006 exposed a non-file module URL and a
      // node:process namespace without cwd() or a module filename. Model that
      // runtime contract in one URL-only SSR chunk while still evaluating the
      // real built Worker.
      const nonFileUrl = chunk.code.replace("import.meta.url", JSON.stringify("worker"));
      if (nonFileUrl === chunk.code) {
        this.error("Expected the module identity chunk to contain import.meta.url");
      }
      chunk.code = nonFileUrl
        .replace(/import\s*\*\s*as\s+([\w$]+)\s*from\s*["']node:process["'];?/, "const $1={};")
        .replace("import.meta.filename", "undefined");
    },
  };
}

export default defineConfig({
  plugins: [
    vinext(),
    simulateLegacyWorkerdModuleIdentity(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
