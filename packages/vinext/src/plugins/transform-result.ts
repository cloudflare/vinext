import type MagicString from "magic-string";

export type MagicStringTransformResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

/** Build the standard code + sourcemap result returned by source transforms. */
export function magicStringTransformResult(
  output: MagicString,
  options: Parameters<MagicString["generateMap"]>[0] = { hires: "boundary" },
): MagicStringTransformResult {
  return {
    code: output.toString(),
    map: output.generateMap(options),
  };
}
