import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

// The end marker of each chunk vite-plugin-commonjs prepends to a module (its
// hoisted imports and its `module` / `exports` polyfill), on one line in front
// of the module's original first byte.
const PREPENDED_CHUNK_END_RE = /\/\* \[vite-plugin-commonjs\] [\w-]+-E \*\/$/;

// ECMAScript line terminators, any of which can end a hashbang.
const LINE_TERMINATOR_RE = /[\n\r\u2028\u2029]/;

function firstLine(code: string): string {
  const end = code.search(LINE_TERMINATOR_RE);
  return end === -1 ? code : code.slice(0, end);
}

/**
 * Turns the hashbang of `source` into a line comment in `output`, the code
 * vite-plugin-commonjs produced from it, where the plugin's prepended code
 * moved it off byte 0, the only place it is valid syntax. Returns `undefined`
 * when there is nothing to change.
 *
 * Next.js's webpack does the same for every module (CompatibilityPlugin
 * comments out a leading `#!`). `//` is as long as `#!`, so the plugin's
 * source map stays valid.
 */
export function commentOutDisplacedHashbang(source: string, output: string): string | undefined {
  if (!source.startsWith("#!")) return undefined;
  // The plugin never rewrites the hashbang line, so it ends the output's
  // first line, right after the last prepended chunk.
  const hashbangLine = firstLine(source);
  const outputLine = firstLine(output);
  const hashbang = outputLine.length - hashbangLine.length;
  if (
    hashbang <= 0 ||
    !outputLine.endsWith(hashbangLine) ||
    !PREPENDED_CHUNK_END_RE.test(outputLine.slice(0, hashbang))
  ) {
    return undefined;
  }
  return `${output.slice(0, hashbang)}//${output.slice(hashbang + 2)}`;
}

/**
 * Applies {@link commentOutDisplacedHashbang} in the client dependency
 * optimizer's Rolldown builds (scan and pre-bundle), where
 * vite-plugin-commonjs's pre-bundle plugin reads and converts files without
 * vinext's transform wrapper. Its output reaches this hook as the loaded code,
 * so the source is read from disk, as that plugin does.
 */
export const commonJsHashbangOptimizeDepsPlugin: Plugin = {
  name: "vinext:commonjs-hashbang:optimize-deps",
  transform: {
    filter: { code: { include: /\[vite-plugin-commonjs\] [\w-]+-E \*\/#!/ } },
    async handler(code, id) {
      let source: string;
      try {
        source = await readFile(id, "utf8");
      } catch {
        return null;
      }
      const output = commentOutDisplacedHashbang(source, code);
      // The replacement moves no code, so the existing mappings still hold.
      return output === undefined ? null : { code: output, map: null };
    },
  },
};
