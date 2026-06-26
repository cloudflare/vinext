/**
 * Code generation for the `virtual:vinext-image-adapters` module, resolved by
 * the vinext vite plugin from the user's `images` config ({@link VinextImageConfig}).
 *
 * The generated module exports `registerConfiguredImageOptimizer(env)`, which the
 * server entries call on each request. It self-guards (the optimizer instantiates
 * once per isolate) and is a no-op when nothing is configured. Registration is
 * resilient: a factory that throws (e.g. a Cloudflare Images adapter on the
 * Node.js server, where the `IMAGES` binding can't exist) is logged and skipped
 * rather than failing every request, so the same config can be registered from
 * every runtime/router entry. When no optimizer is registered, image requests
 * fall back to serving the original asset unoptimized.
 *
 * Descriptor `options` are inlined into the generated module and forwarded to the
 * factory at runtime, so a config-time builder like `imagesOptimizer({ binding })`
 * never touches the Workers runtime — instantiation is deferred to the first
 * request.
 *
 * This mirrors the cache-adapter pattern in `cache/cache-adapters-virtual.ts`.
 */

/**
 * A serializable pointer to an image optimizer adapter module — the shape of the
 * `images.optimizer` slot in the vinext() plugin config. Produced by an adapter
 * builder (e.g. `imagesOptimizer(...)` from `@vinext/cloudflare/images/images-optimizer`)
 * or written by hand. `options` must be JSON-serializable: it is inlined into the
 * generated registration module and forwarded to the adapter factory at runtime.
 */
type ImageAdapterDescriptor<O extends Record<string, unknown> = Record<string, unknown>> = {
  /**
   * Module specifier (or absolute path, e.g. from `require.resolve(...)`) whose
   * default export is an image optimizer factory.
   */
  adapter: string;
  /** JSON-serializable options forwarded to the factory at runtime. */
  options?: O;
};

/**
 * The `images` option of the vinext() plugin: declaratively register the
 * server-side image optimizer (transform backend) instead of wiring `env.IMAGES`
 * into a custom worker entry.
 *
 * This is complementary to the `images` field in `next.config.js`, which
 * configures the standard Next.js image options (`remotePatterns`, `deviceSizes`,
 * `dangerouslyAllowSVG`, etc.). Those continue to be read from next.config; this
 * option only selects the runtime transform backend, which can't be expressed as
 * serializable next.config data.
 */
export type VinextImageConfig = {
  /** Server-side image optimizer adapter (the `/_next/image` transform backend). */
  optimizer?: ImageAdapterDescriptor;
};

/** Public virtual module id imported by the server entries. */
export const VIRTUAL_IMAGE_ADAPTERS = "virtual:vinext-image-adapters";

/**
 * Serialize descriptor options into a JS expression for inlining. Plain JSON is
 * a valid JS literal; `undefined` when there are no options. Throws a clear
 * config-time error (not a runtime one) if options are not serializable.
 */
function inlineOptions(adapter: string, options: Record<string, unknown> | undefined): string {
  if (options === undefined) return "undefined";
  try {
    return JSON.stringify(options);
  } catch (cause) {
    throw new Error(`[vinext] image adapter "${adapter}" options must be JSON-serializable.`, {
      cause,
    });
  }
}

/**
 * Generate the source of the `virtual:vinext-image-adapters` module for the
 * given config. Always exports `registerConfiguredImageOptimizer(env)`.
 */
export function generateImageAdaptersModule(images?: VinextImageConfig): string {
  const optimizer = images?.optimizer;

  // Nothing configured → a no-op so the unconditional import in the server
  // entries stays valid and tree-shakes to almost nothing.
  if (!optimizer?.adapter) {
    return [
      "// vinext: no images.optimizer adapter configured — registration is a no-op.",
      "export function registerConfiguredImageOptimizer() {}",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    "// vinext: generated from the `images` option in your vinext() plugin config.",
    `import __vinextImageOptimizerFactory from ${JSON.stringify(optimizer.adapter)};`,
    `import { setImageOptimizer } from "vinext/server/image-optimization";`,
    "",
    "// A factory that throws (e.g. a missing binding on an incompatible runtime)",
    "// is logged and skipped so images fall back to unoptimized passthrough.",
    "let __vinextImageOptimizerRegistered = false;",
    "",
    "export function registerConfiguredImageOptimizer(env) {",
    "  if (__vinextImageOptimizerRegistered) return;",
    "  __vinextImageOptimizerRegistered = true;",
    "  try {",
    `    setImageOptimizer(__vinextImageOptimizerFactory({ env, options: ${inlineOptions(
      optimizer.adapter,
      optimizer.options,
    )} }));`,
    "  } catch (error) {",
    '    console.warn("[vinext] failed to initialize the configured image optimizer; ' +
      'serving images unoptimized.", error);',
    "  }",
    "}",
    "",
  ];

  return lines.join("\n");
}
