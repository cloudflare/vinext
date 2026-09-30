import type MagicString from "magic-string";

export type MagicStringTransformResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

type SourcemapEnvironment = {
  mode?: string;
  config?: { build?: { sourcemap?: boolean | "inline" | "hidden" } };
};

/** Build the standard code + sourcemap result returned by source transforms. */
export function magicStringTransformResult(
  output: MagicString,
  options: Parameters<MagicString["generateMap"]>[0] = { hires: "boundary" },
): MagicStringTransformResult {
  // High-resolution maps for large dependencies are expensive, and cached
  // results are not always consumed with their map, so generate it on first read.
  let source: MagicString | undefined = output;
  let map: MagicStringTransformResult["map"] | undefined;
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

/** Whether a build environment discards transform sourcemaps. */
export function buildDiscardsSourcemap(environment: SourcemapEnvironment | undefined): boolean {
  return environment?.mode === "build" && environment.config?.build?.sourcemap === false;
}

/**
 * Drop the sourcemap from a transform result when the build environment
 * discards it, mirroring Vite's own transforms
 * (`config.build.sourcemap ? s.generateMap(...) : null`). Dev and builds with
 * sourcemaps enabled keep the result unchanged.
 */
export function omitUnusedBuildSourcemap(
  environment: SourcemapEnvironment | undefined,
  result: MagicStringTransformResult | null,
): { code: string; map: MagicStringTransformResult["map"] | null } | null {
  if (!result || !buildDiscardsSourcemap(environment)) return result;
  // Read only `code`: spreading the result would generate the lazy map.
  return { code: result.code, map: null };
}
