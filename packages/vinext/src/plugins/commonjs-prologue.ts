import MagicString from "magic-string";
import type { Plugin } from "vite";
import { parseProgram } from "./ast-utils.js";
import {
  commonJsPrependedBlocksEnd,
  EXPORT_FACADE_START,
  PREPENDED_BLOCK_START_RE,
} from "./commonjs-markers.js";

// A hashbang comment runs to the first line terminator.
const HASHBANG_RE = /^#![^\n\r\u2028\u2029]*/;

// Whitespace and comments, then a string literal: a possible directive. Each
// comment alternative ends at its own terminator, so a match is unambiguous.
const DIRECTIVE_CANDIDATE_RE =
  /^(?:\s|\/\/[^\n\r\u2028\u2029]*[\n\r\u2028\u2029]|\/\*(?:[^*]|\*(?!\/))*\*\/)*["']/;

/**
 * Moves the blocks vite-plugin-commonjs prepended to a converted module after
 * the module's prologue: its hashbang (`#!`) line and its directives.
 *
 * The plugin prepends them at offset 0. Ahead of a hashbang that is a syntax
 * error, and ahead of a directive (`"use client"`, `"use server"`) the
 * directive becomes a plain expression statement, so the module silently
 * stops being a client or server reference. Next.js accepts both.
 */
export function moveCommonJsPrependedBlocksAfterPrologue(code: string): MagicString | undefined {
  const blocksEnd = commonJsPrependedBlocksEnd(code);
  if (blocksEnd === 0) return undefined;
  const body = code.slice(blocksEnd);
  const hashbangEnd = HASHBANG_RE.exec(body)?.[0].length ?? 0;
  let insertAt: number | undefined;
  // Keeps the moved blocks out of the hashbang comment, and from running
  // into a directive that has no semicolon.
  let separator = "";

  if (DIRECTIVE_CANDIDATE_RE.test(body.slice(hashbangEnd))) {
    // The export facade the plugin appends after the module's code can
    // duplicate the module's own ESM exports until it is removed (after this
    // hook in the dependency optimizer), which makes the module unparsable.
    // Directives come first, so parse only the code ahead of it. A module
    // that still fails to parse keeps the hashbang repair below, so its error
    // points at its own syntax rather than at `#!`.
    const facadeStart = body.lastIndexOf(EXPORT_FACADE_START);
    let statements: readonly { type: string; directive?: unknown; end: number }[] = [];
    try {
      statements = parseProgram(facadeStart === -1 ? body : body.slice(0, facadeStart)).body;
    } catch {
      // Fall through to the hashbang repair.
    }
    for (const statement of statements) {
      if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string") {
        break;
      }
      insertAt = statement.end;
    }
    if (insertAt !== undefined && body[insertAt - 1] !== ";") separator = ";";
  }

  if (insertAt === undefined && hashbangEnd > 0) {
    insertAt = hashbangEnd;
    separator = "\n";
  }
  if (insertAt === undefined) return undefined;

  const output = new MagicString(code);
  output.move(0, blocksEnd, blocksEnd + insertAt);
  if (separator) output.appendLeft(blocksEnd + insertAt, separator);
  return output;
}

/**
 * Runs {@link moveCommonJsPrependedBlocksAfterPrologue} right after
 * vite-plugin-commonjs, in Vite environments and in the dependency optimizer
 * (where the plugin converts files in its own pre-bundle loader). A separate
 * transform keeps the plugin's source map exact: Vite and Rolldown combine
 * the two maps.
 */
export const commonJsProloguePlugin: Plugin = {
  name: "vinext:commonjs-prologue",
  transform: {
    filter: { code: { include: PREPENDED_BLOCK_START_RE } },
    handler(code, id) {
      const output = moveCommonJsPrependedBlocksAfterPrologue(code);
      if (!output) return null;
      return {
        code: output.toString(),
        map: output.generateMap({ source: id, hires: "boundary" }),
      };
    },
  },
};
