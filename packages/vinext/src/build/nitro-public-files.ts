/** The Nitro options this integration reads and updates. */
export type NitroPublicFilesOptions = {
  dev?: boolean;
  preset?: string;
  baseURL?: string;
  serveStatic?: boolean | string;
  plugins?: string[];
  virtual?: Record<string, string | (() => string)>;
};

const NITRO_PUBLIC_FILES_PLUGIN = "#vinext/nitro-public-files";
// AWS Amplify turns on `serveStatic`, but its CDN serves the static output
// and the compute bundle can't read it.
const CDN_STATIC_PRESETS = new Set(["aws-amplify"]);

/**
 * Register vinext's Nitro runtime plugin on presets whose server serves the
 * static output, so vinext can serve the public files its router resolves.
 *
 * Nitro serves the static output from its root, so this applies only when
 * Nitro's `baseURL` is the root; vinext applies its own `basePath`. Returns
 * whether the plugin is registered.
 */
export function registerNitroPublicFiles(
  options: NitroPublicFilesOptions,
  pluginModule: string,
): boolean {
  if (options.dev || !options.serveStatic) return false;
  if (options.preset && CDN_STATIC_PRESETS.has(options.preset.replaceAll("_", "-"))) return false;
  if ((options.baseURL ?? "/") !== "/") return false;

  options.virtual ??= {};
  options.virtual[NITRO_PUBLIC_FILES_PLUGIN] = [
    `import { createNitroPublicFilesPlugin } from ${JSON.stringify(pluginModule)};`,
    "export default createNitroPublicFilesPlugin();",
    "",
  ].join("\n");
  options.plugins ??= [];
  if (!options.plugins.includes(NITRO_PUBLIC_FILES_PLUGIN)) {
    options.plugins.push(NITRO_PUBLIC_FILES_PLUGIN);
  }
  return true;
}
