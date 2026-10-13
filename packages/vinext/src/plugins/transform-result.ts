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
