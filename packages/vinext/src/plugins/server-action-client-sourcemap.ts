import fs from "node:fs/promises";
import { parseAstAsync, type Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";

const SCRIPT_MODULE_RE = /\.([cm]?[jt]sx?)(?:[?#]|$)/;

function parserLang(extension: string): "jsx" | "ts" | "tsx" {
  if (extension.endsWith("tsx")) return "tsx";
  return extension.endsWith("ts") ? "ts" : "jsx";
}

async function isUseServerModule(code: string, extension: string): Promise<boolean> {
  if (!code.includes("use server")) return false;
  try {
    const program = await parseAstAsync(code, { lang: parserLang(extension) });
    return program.body.some(
      (statement) =>
        statement.type === "ExpressionStatement" &&
        statement.expression.type === "Literal" &&
        statement.expression.value === "use server",
    );
  } catch {
    // A later plugin may still compile this syntax into a "use server"
    // module, so drop the mappings rather than risk publishing its source.
    return true;
  }
}

/**
 * Keep `"use server"` module source out of production browser sourcemaps.
 *
 * In client environments `@vitejs/plugin-rsc` replaces a `"use server"`
 * module with `createServerReference()` proxies, so its implementation never
 * reaches browser JavaScript. Rolldown still seeds the module's sourcemap
 * chain with the loaded file, so an enabled client sourcemap would publish
 * the full server-only source in `sourcesContent`. A later transform cannot
 * remove it: Rolldown keeps the first map's sources even when the final
 * mappings no longer point at them.
 *
 * Loading the module with an empty map starts the chain with no original
 * source, so the generated proxy maps to nothing and the module disappears
 * from the emitted map. This matches Next.js, which drops the original
 * mappings when compiling server actions for the client in production builds
 * and keeps them in development and server builds:
 * crates/next-custom-transforms/src/transforms/server_actions.rs (#76157),
 * test/e2e/app-dir/actions/app-action.test.ts
 * ("should not expose action content in sourcemaps").
 *
 * The hook runs with the post plugins, standing in for Vite's filesystem load
 * fallback, so earlier loaders that own a module (`?raw`, `?url`, workers,
 * user plugins) keep it, along with their own map. It must not use
 * `order: "post"`: that would run it after `builtin:vite-load-fallback`,
 * which loads query-suffixed ids. It runs whether or not sourcemaps are
 * configured, because a plugin can still enable them through `outputOptions`
 * after modules are loaded.
 */
export function createServerActionClientSourcemapPlugin(): Plugin {
  return {
    name: "vinext:server-action-client-sourcemap",
    apply: "build",
    enforce: "post",
    load: {
      filter: { id: { include: SCRIPT_MODULE_RE, exclude: /\0/ } },
      async handler(id) {
        if (this.environment?.config.consumer !== "client") return null;
        const extension = SCRIPT_MODULE_RE.exec(id)?.[1];
        if (!extension) return null;

        let code: string;
        try {
          code = await fs.readFile(stripViteModuleQuery(id), "utf8");
        } catch {
          return null;
        }
        if (!(await isUseServerModule(code, extension))) return null;
        return { code, map: { mappings: "" } };
      },
    },
  };
}
