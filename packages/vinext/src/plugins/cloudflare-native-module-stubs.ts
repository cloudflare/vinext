import { toSlash } from "pathslash";
import type { Plugin } from "vite";

const NATIVE_MODULE_STUB_ID = "\0vinext:cloudflare-native-module-stub";

/**
 * Packages that load Node-API addons (`.node` binaries) and so can never run
 * on workerd. Bundling some of them fails outright (`@resvg/resvg-js` and
 * `@napi-rs/canvas` statically require their binaries); the rest bundle but
 * throw from their module body, taking down every route that shares a chunk
 * with them.
 */
const NATIVE_MODULES = ["@resvg/resvg-js", "@napi-rs/canvas", "sharp", "lightningcss"];

const NATIVE_MODULE_RE = new RegExp(
  `^(?:${NATIVE_MODULES.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(?:/|$)`,
);

const NATIVE_MODULE_STUB_ID_RE = new RegExp(`^${NATIVE_MODULE_STUB_ID}$`);

/**
 * The dependency optimizer bundles packages in its own Rolldown pipeline,
 * outside Vite's plugin container, so a dependency's `require("sharp")` needs
 * the stub there as well. That pipeline applies `resolve.alias` only after
 * this plugin, so resolve first and keep any alias target the app configured.
 */
const optimizeDepsStubPlugin: Plugin = {
  name: "vinext:cloudflare-native-module-stubs:optimize-deps",
  resolveId: {
    filter: { id: NATIVE_MODULE_RE },
    async handler(id, importer, options) {
      const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
      const packageName = id.split("/", id.startsWith("@") ? 2 : 1).join("/");
      if (resolved && !toSlash(resolved.id).includes(`/node_modules/${packageName}/`)) {
        return resolved;
      }
      return NATIVE_MODULE_STUB_ID;
    },
  },
  load: {
    filter: { id: NATIVE_MODULE_STUB_ID_RE },
    handler: () => "module.exports = {};",
  },
};

/**
 * Resolve native Node modules to an empty module when building for Cloudflare,
 * so importing one does not break the build or every route around it. Code
 * that actually calls into the module still fails, but only where it runs.
 * Every environment is covered: the client dep optimizer crawls server-only
 * files under app/ too, and no browser can load a `.node` addon either. In
 * the browser during dev the stub is plain ESM, so only a default import of
 * it loads there.
 */
export function createCloudflareNativeModuleStubsPlugin(isCloudflare: () => boolean): Plugin {
  return {
    name: "vinext:cloudflare-native-module-stubs",
    enforce: "pre",
    configEnvironment(_name, config) {
      if (!isCloudflare()) return;
      config.optimizeDeps ??= {};
      config.optimizeDeps.rolldownOptions ??= {};
      const configuredPlugins = config.optimizeDeps.rolldownOptions.plugins;
      config.optimizeDeps.rolldownOptions.plugins = [
        ...(Array.isArray(configuredPlugins)
          ? configuredPlugins
          : configuredPlugins
            ? [configuredPlugins]
            : []),
        optimizeDepsStubPlugin,
      ];
    },
    resolveId: {
      filter: { id: NATIVE_MODULE_RE },
      handler() {
        return isCloudflare() ? NATIVE_MODULE_STUB_ID : undefined;
      },
    },
    load: {
      filter: { id: NATIVE_MODULE_STUB_ID_RE },
      handler() {
        // Rolldown accepts any named import from a CommonJS module, so
        // `import { Resvg } from "@resvg/resvg-js"` still builds. Vite's dev
        // module runner (server environments) does not evaluate CommonJS, but
        // reads named imports as plain properties, so an ESM default export is
        // enough there.
        return this.environment?.mode === "build" ? "module.exports = {};" : "export default {};";
      },
    },
  };
}
