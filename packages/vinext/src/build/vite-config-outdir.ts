import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "pathslash";

/**
 * Vite's `build.outDir` from the project's Vite config file, resolved from
 * `root`. Undefined when the config sets none, or when the project's Vite or
 * config can't be loaded, as in a production install without Vite or the
 * config's plugins.
 */
export async function readViteConfigOutDir(root: string): Promise<string | undefined> {
  let vitePath: string;
  try {
    vitePath = createRequire(path.join(root, "package.json")).resolve("vite");
  } catch {
    return undefined;
  }
  try {
    const vite = (await import(/* @vite-ignore */ pathToFileURL(vitePath).href)) as Pick<
      typeof import("vite"),
      "loadConfigFromFile"
    >;
    const loaded = await vite.loadConfigFromFile(
      { command: "build", mode: "production" },
      undefined,
      root,
      "silent",
    );
    const outDir = loaded?.config.build?.outDir;
    return typeof outDir === "string" && outDir !== "" ? path.resolve(root, outDir) : undefined;
  } catch {
    return undefined;
  }
}
