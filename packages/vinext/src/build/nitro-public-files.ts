import fs from "node:fs";
import path from "pathslash";

/** The Nitro options this integration reads and updates. */
export type NitroPublicFilesOptions = {
  dev?: boolean;
  preset?: string;
  baseURL?: string;
  serveStatic?: boolean | string;
  plugins?: string[];
  virtual?: Record<string, string | (() => string)>;
  output?: { publicDir?: string };
};

const NITRO_PUBLIC_FILES_PLUGIN = "#vinext/nitro-public-files";
// AWS Amplify turns on `serveStatic`, but its CDN serves the static output
// and the compute bundle can't read it.
const CDN_STATIC_PRESETS = new Set(["aws-amplify"]);

// `compressPublicAssets` writes these copies next to a file.
const COMPRESSED_EXTENSIONS = [".br", ".gz", ".zst"];

// Nitro keys a static file by its path relative to the output directory,
// decoded and then joined to `/`.
function toNitroAssetId(relativePath: string): string {
  let decoded = relativePath;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    // Nitro's build fails on such a name; key it as it is.
  }
  return "/" + decoded.replace(/^\.?\//, "");
}

/**
 * List the static files Nitro serves for the files in `public/`, keyed as
 * Nitro's static handler keys them: each file that Nitro copied to its output
 * directory, and the compressed copies of it that Nitro wrote there.
 */
function listNitroPublicAssets(
  publicFiles: string[],
  outputPublicDir: string | undefined,
): string[] {
  if (!outputPublicDir) return [];
  const assets: string[] = [];
  for (const file of publicFiles) {
    const relativePath = file.slice(1);
    for (const extension of ["", ...COMPRESSED_EXTENSIONS]) {
      const stat = fs.statSync(path.join(outputPublicDir, relativePath + extension), {
        throwIfNoEntry: false,
      });
      if (stat?.isFile()) {
        assets.push(toNitroAssetId(relativePath + extension));
      }
    }
  }
  return [...new Set(assets)].sort();
}

/**
 * Register vinext's Nitro runtime plugin on presets whose server serves the
 * static output, so requests for public files run through vinext, including
 * its middleware, and vinext can serve the public files its router resolves.
 *
 * Nitro serves the static output from its root, so this applies only when
 * Nitro's `baseURL` is the root; vinext applies its own `basePath`. Returns
 * whether the plugin is registered.
 */
export function registerNitroPublicFiles(
  options: NitroPublicFilesOptions,
  pluginModule: string,
  getPublicFiles: () => string[],
): boolean {
  if (options.dev || !options.serveStatic) return false;
  if (options.preset && CDN_STATIC_PRESETS.has(options.preset.replaceAll("_", "-"))) return false;
  if ((options.baseURL ?? "/") !== "/") return false;

  options.virtual ??= {};
  // Nitro evaluates the template when it bundles the server, after Vite has
  // resolved the public directory and Nitro has written its static output.
  options.virtual[NITRO_PUBLIC_FILES_PLUGIN] = () =>
    [
      'import { fetchViteEnv } from "nitro/vite/runtime";',
      `import { createNitroPublicFilesPlugin } from ${JSON.stringify(pluginModule)};`,
      "export default createNitroPublicFilesPlugin({",
      `  publicAssets: ${JSON.stringify(listNitroPublicAssets(getPublicFiles(), options.output?.publicDir))},`,
      '  fetchApp: (request) => fetchViteEnv("ssr", request),',
      "});",
      "",
    ].join("\n");
  options.plugins ??= [];
  if (!options.plugins.includes(NITRO_PUBLIC_FILES_PLUGIN)) {
    options.plugins.push(NITRO_PUBLIC_FILES_PLUGIN);
  }
  return true;
}
