import type MagicString from "magic-string";

export type MagicStringTransformResult<TMap = ReturnType<MagicString["generateMap"]>> = {
  code: string;
  map: TMap;
};

// Outputs can come from @vitejs/plugin-rsc's transforms, which may use a
// different magic-string major (and SourceMap type) than vinext.
type MagicStringOutput<TMap> = {
  toString(): string;
  generateMap(options: Parameters<MagicString["generateMap"]>[0]): TMap;
};

type SourcemapEnvironment = {
  mode?: string;
  config?: { build?: { sourcemap?: boolean | "inline" | "hidden" } };
};

/** Build the standard code + sourcemap result returned by source transforms. */
export function magicStringTransformResult<TMap = ReturnType<MagicString["generateMap"]>>(
  output: MagicStringOutput<TMap>,
  options: Parameters<MagicString["generateMap"]>[0] = { hires: "boundary" },
): MagicStringTransformResult<TMap> {
  // High-resolution maps for large dependencies are expensive, and cached
  // results are not always consumed with their map, so generate it on first read.
  let source: MagicStringOutput<TMap> | undefined = output;
  let map: TMap | undefined;
  return {
    code: output.toString(),
    get map() {
      if (source) {
        map = source.generateMap(options);
        // Cached results outlive the transform; keep only the generated map.
        source = undefined;
      }
      return map!;
    },
  };
}

/**
 * Build the result of a transform that replaces a module with Server Function
 * reference proxies. Like @vitejs/plugin-rsc's `rsc:use-server`, builds return
 * an empty map so the replaced module's source doesn't ship in sourcemaps.
 * Rolldown < 1.2.18 (Vite < 8.3.7) refills empty maps with the module's
 * original code, so this needs Rolldown >= 1.2.18 to take effect.
 */
export function serverReferenceProxyResult<TMap = ReturnType<MagicString["generateMap"]>>(
  environment: { mode: string },
  output: MagicStringOutput<TMap>,
  options?: Parameters<MagicString["generateMap"]>[0],
): MagicStringTransformResult<TMap | { mappings: "" }> {
  if (environment.mode === "build") return { code: output.toString(), map: { mappings: "" } };
  return magicStringTransformResult(output, options);
}

/**
 * Drop the sourcemap from a transform result when the build environment
 * discards it, mirroring Vite's own transforms
 * (`config.build.sourcemap ? s.generateMap(...) : null`). Dev and builds with
 * sourcemaps enabled keep the result unchanged.
 */
export function omitUnusedBuildSourcemap<TMap = ReturnType<MagicString["generateMap"]>>(
  environment: SourcemapEnvironment | undefined,
  result: MagicStringTransformResult<TMap> | null,
): { code: string; map: TMap | null } | null {
  if (!result || environment?.mode !== "build" || environment.config?.build?.sourcemap !== false) {
    return result;
  }
  // Read only `code`: spreading the result would generate the lazy map.
  return { code: result.code, map: null };
}
