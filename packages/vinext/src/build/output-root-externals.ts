import MagicString from "magic-string";
import path from "pathslash";
import { escapeRegExp } from "../utils/regex.js";

/**
 * Rewrite external virtual ids into imports of files that live at a fixed
 * place relative to the output root.
 *
 * Some server modules (the cacheability manifest, the pregenerated concrete
 * paths, the Pages client assets) are written beside the server entry, and
 * deploy steps can rewrite them after the build. Rolldown leaves a relative
 * external specifier exactly as written, but it can move the importing module
 * into any chunk, for example a shared chunk under `_next/static/` when the
 * entry becomes a facade. Keeping the virtual id external and resolving it
 * against each chunk's own location keeps the import pointing at the file.
 *
 * `targets` maps each external id to its file path relative to the output root.
 */
export function rewriteOutputRootExternals(
  code: string,
  chunkFileName: string,
  targets: ReadonlyMap<string, string>,
): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  let output: MagicString | null = null;
  const chunkDir = path.posix.dirname(chunkFileName);
  for (const [id, target] of targets) {
    if (!code.includes(id)) continue;
    let specifier = path.posix.relative(chunkDir, target);
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    const quotedId = new RegExp(`(["'])${escapeRegExp(id)}\\1`, "g");
    for (const match of code.matchAll(quotedId)) {
      output ??= new MagicString(code);
      const quote = match[1];
      output.overwrite(match.index, match.index + match[0].length, quote + specifier + quote);
    }
  }
  if (output === null) return null;
  return { code: output.toString(), map: output.generateMap({ hires: "boundary" }) };
}
