/**
 * Unit tests for vinext:fix-use-server-closure-collision.
 *
 * Strategy: extract the plugin from the vinext() array, call its transform()
 * directly, then pipe the result through plugin-rsc's
 * transformHoistInlineDirective — the same two-step pipeline that runs in dev.
 *
 * With the plugin commented out (current state), transform() returns null and
 * the raw source reaches transformHoistInlineDirective unchanged.  periscopic
 * then mis-classifies the inner `const cookies` as a closure variable, plugin-rsc
 * injects `const [cookies] = decryptActionBoundArgs(...)` at the top of the
 * hoisted function, and the output contains two `const cookies` declarations in
 * the same block — a SyntaxError when Vite's module runner evaluates it.
 *
 * With the plugin active, it renames `const cookies` (and its usages) inside
 * the 'use server' body to `__local_cookies` before plugin-rsc sees the file.
 * periscopic no longer sees `cookies` referenced in the action, so it is not
 * injected as a bindVar.  The output has no duplicate declaration and parses
 * correctly.
 */

import { describe, it, expect } from "vitest";
import { parseAst } from "vite";
import { transformHoistInlineDirective } from "@vitejs/plugin-rsc/transforms";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

function getCollisionPlugin(): Plugin | undefined {
  const plugins = (vinext() as Plugin[]).flat(Infinity) as Plugin[];
  return plugins.find((p) => p?.name === "vinext:fix-use-server-closure-collision");
}

/**
 * Run the two-step pipeline that Vite uses in dev:
 *   1. vinext:fix-use-server-closure-collision (enforce: pre)  — may be a no-op if commented out
 *   2. transformHoistInlineDirective from @vitejs/plugin-rsc
 *
 * Returns the final output string.
 */
async function runPipeline(source: string, id = "/app/actions/page.tsx"): Promise<string> {
  let code = source;

  const plugin = getCollisionPlugin();
  if (plugin?.transform) {
    const transform = unwrapHook(plugin.transform);
    const result = await transform.call(plugin, code, id);
    if (result != null) {
      code = typeof result === "string" ? result : result.code;
    }
  }

  const ast = parseAst(code);
  const { output } = transformHoistInlineDirective(code, ast, {
    runtime: (name: string) => `registerServerReference(${name}, "test-module", "${name}")`,
    decode: (arg: string) => `decryptActionBoundArgs(${arg})`,
    rejectNonAsyncFunction: false,
  });
  return output.toString();
}

/**
 * Count occurrences of a pattern in a string.
 */
function countMatches(str: string, pattern: RegExp): number {
  return (str.match(pattern) ?? []).length;
}

// ---------------------------------------------------------------------------
// The collision fixture — mirrors closure-collision/page.tsx
// ---------------------------------------------------------------------------

const COLLISION_SOURCE = `
function buildAction(config) {
  const cookies = "session";

  async function submitAction(formData) {
    "use server";
    const cookies = formData.get("value") + ":" + config;
    return cookies;
  }

  return { submitAction, outerCookies: cookies };
}

const { submitAction, outerCookies } = buildAction("cfg");
export default function Page() { return null; }
`.trimStart();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vinext:fix-use-server-closure-collision", () => {
  it("plugin is present in the vinext() plugin array (will be active once uncommented)", () => {
    // This test documents intent: the plugin should exist.
    // It currently returns undefined because the plugin is commented out.
    // Once uncommented this assertion flips to toBeDefined().
    const plugin = getCollisionPlugin();
    expect(plugin).toBeDefined();
  });

  it("reproduces the bug: transformHoistInlineDirective on raw source produces a duplicate const declaration", () => {
    // Bypass the vinext plugin entirely and call transformHoistInlineDirective
    // directly on the unmodified source — this is what happened before the fix
    // existed. periscopic sees `cookies` referenced inside the action and finds
    // its owner in the outer function's BlockStatement scope — not the action's
    // scope and not the Program scope — so it classifies it as a closure var.
    // plugin-rsc injects:
    //   const [cookies, config] = decryptActionBoundArgs($$hoist_encoded);
    // But the action body already has:
    //   const cookies = formData.get("value") + ":" + config;
    // → two `const cookies` in the same block.

    const ast = parseAst(COLLISION_SOURCE);
    const { output } = transformHoistInlineDirective(COLLISION_SOURCE, ast, {
      runtime: (name: string) => `registerServerReference(${name}, "test-module", "${name}")`,
      decode: (arg: string) => `decryptActionBoundArgs(${arg})`,
      rejectNonAsyncFunction: false,
    });
    const result = output.toString();

    // The injected bindVar destructuring and the original declaration are both present
    const duplicateCount = countMatches(result, /\bconst cookies\b/g);
    expect(
      duplicateCount,
      `expected 2 occurrences of 'const cookies' (injected + original) in:\n${result}`,
    ).toBeGreaterThanOrEqual(2);
  });

  it("fix: with the plugin active, the output has no duplicate const declaration", async () => {
    // This test will FAIL until the plugin is uncommented in index.ts.
    // Once active the plugin renames the inner `cookies` to `__local_cookies`,
    // periscopic no longer sees `cookies` as referenced inside the action,
    // and the injected bindVar line is absent — eliminating the collision.

    const output = await runPipeline(COLLISION_SOURCE);

    // After the fix there must be at most one `const cookies` in the output
    // (the outer `const cookies = "session"` that lives outside the hoisted fn).
    const duplicateCount = countMatches(output, /\bconst cookies\b/g);
    expect(
      duplicateCount,
      `expected at most 1 occurrence of 'const cookies' after fix, got ${duplicateCount}:\n${output}`,
    ).toBeLessThanOrEqual(1);

    // The rename should be visible in the hoisted function body
    expect(output).toContain("__local_cookies");

    // Only `config` should remain as a bound closure var
    expect(output).toContain("const [config]");
    expect(output).not.toMatch(/const \[.*cookies.*\]/);
  });

  it("does not affect actions with no shadowing collision", async () => {
    // `result` is only declared inside the action; `config` is a genuine
    // closure var from the outer scope and is NOT redeclared inside the action.
    // No collision → the plugin should be a no-op and the output should be valid.
    const safe = `
function buildAction(config) {
  async function submitAction(formData) {
    "use server";
    const result = formData.get("value") + ":" + config;
    return result;
  }
  return submitAction;
}
export const action = buildAction("cfg");
`.trimStart();

    const output = await runPipeline(safe);

    // `result` is not in outer scope — not injected as a bindVar
    expect(output).not.toContain("const [result");

    // `config` IS a genuine closure var — correctly injected
    expect(output).toContain("const [config]");

    // No duplicate `const result`
    expect(countMatches(output, /\bconst result\b/g)).toBe(1);
  });
});
