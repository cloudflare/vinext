import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import vinext from "vinext";

function recordRscRuntimeProvenance(): Plugin {
  return {
    name: "app-with-src:rsc-runtime-provenance",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const runtimeModuleIds = Object.values(bundle).flatMap((output) =>
        output.type === "chunk"
          ? output.moduleIds.filter((id) => id.includes("react-server-dom"))
          : [],
      );
      if (runtimeModuleIds.length === 0) return;

      const outputPath = path.join(
        import.meta.dirname,
        "dist",
        `rsc-runtime-${this.environment.name}.json`,
      );
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(runtimeModuleIds.sort(), null, 2)}\n`);
    },
  };
}

export default defineConfig({
  plugins: [vinext({ appDir: `${import.meta.dirname}/src` }), recordRscRuntimeProvenance()],
});
