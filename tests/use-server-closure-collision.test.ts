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
  const { output } = transformHoistInlineDirective(
    code,
    ast as Parameters<typeof transformHoistInlineDirective>[1],
    {
      directive: "use server",
      runtime: (name: string) => `registerServerReference(${name}, "test-module", "${name}")`,
      decode: (arg: string) => `decryptActionBoundArgs(${arg})`,
      rejectNonAsyncFunction: false,
    },
  );
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
export default function Page() { return null; }`.trimStart();

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
    const { output } = transformHoistInlineDirective(
      COLLISION_SOURCE,
      ast as Parameters<typeof transformHoistInlineDirective>[1],
      {
        directive: "use server",
        runtime: (name: string) => `registerServerReference(${name}, "test-module", "${name}")`,
        decode: (arg: string) => `decryptActionBoundArgs(${arg})`,
        rejectNonAsyncFunction: false,
      },
    );
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

  // -------------------------------------------------------------------------
  // Regression tests for bugs identified in bonk review (round 1)
  // -------------------------------------------------------------------------

  // Bug 1: collectOuterNames collected from sibling scopes (false positives).
  // The old whole-AST walk treated variables in unrelated sibling functions as
  // "outer names", causing the inner const to be incorrectly renamed even though
  // there was no actual collision visible to the action.
  it("regression (sibling scope): does not rename a local const that only shares a name with a sibling function's var", async () => {
    const source = `
function other() { const cookies = 1; }
function buildAction(config) {
  async function submitAction(formData) {
    "use server";
    const cookies = formData.get("value") + ":" + config;
    return cookies;
  }
  return submitAction;
}
export const action = buildAction("cfg");
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // `cookies` in `submitAction` is NOT in scope of `other()` — no collision,
    // so the plugin must leave the source unchanged.
    expect(pluginOutput).not.toContain("__local_cookies");
    expect(pluginOutput).toContain("const cookies = formData.get");
  });

  // Bug 2: double s.update() crash for nested "use server" functions.
  // When an outer server function renamed a var, renamingWalk descended into
  // nested server functions (if they didn't re-declare the name), and then
  // visitNode also recursed into the same body — causing s.update() to be
  // called twice on the same range, which MagicString throws on.
  it("regression (double update): outer and inner 'use server' functions with same collision name do not throw", async () => {
    const source = `
function outer(config) {
  const cookies = "session";
  async function outerAction(formData) {
    "use server";
    const cookies = formData.get("outer");
    async function innerAction(fd) {
      "use server";
      const cookies = fd.get("inner");
      return cookies;
    }
    return { cookies, innerAction };
  }
  return outerAction;
}
export const action = outer("cfg");
`.trimStart();

    // Must not throw
    let pluginOutput: string = source;
    await expect(async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result != null) {
        pluginOutput = typeof result === "string" ? result : result.code;
      }
    }).not.toThrow();

    // Both actions must have their inner `cookies` renamed
    expect(pluginOutput).toContain("__local_cookies");
  });

  // Bug 3: hasUseServerDirective used .some() instead of checking the directive
  // prologue. A "use server" string mid-function (not in the prologue) is NOT a
  // directive but the old code treated it as one.
  it("regression (directive prologue): mid-function 'use server' string is not treated as a directive", async () => {
    const source = `
function buildAction(config) {
  const cookies = "session";
  async function notAServerFn(formData) {
    const x = doSomething();
    "use server";
    const cookies = formData.get("value");
    return cookies;
  }
  return notAServerFn;
}
export const action = buildAction("cfg");
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // "use server" is not in the prologue — plugin must leave the source unchanged
    expect(pluginOutput).not.toContain("__local_cookies");
    expect(pluginOutput).toContain("const cookies = formData.get");
  });

  // Bug 4: renamingWalk's re-declaration check only looked at top-level
  // VariableDeclaration statements, missing `var` declarations hoisted from
  // inside if/for/etc. blocks. This caused it to descend into nested functions
  // and rename references that belonged to that nested function's own `var`.
  it("regression (hoisted var): does not rename inside a nested function that re-declares via hoisted var", async () => {
    const source = `
function buildAction(config) {
  const cookies = "session";
  async function submitAction(formData) {
    "use server";
    const cookies = formData.get("value");
    function nested() {
      if (true) { var cookies = "nested"; }
      return cookies;
    }
    return cookies + nested();
  }
  return submitAction;
}
export const action = buildAction("cfg");
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // The `var cookies` inside `nested()` means `nested`'s own `return cookies`
    // refers to its own binding — must not be renamed.
    expect(pluginOutput).toContain('var cookies = "nested"');
    // The body of nested() must not have __local_cookies
    const nestedFnMatch = pluginOutput.match(/function nested\(\)[\s\S]*?return cookies;/);
    expect(nestedFnMatch?.[0]).not.toContain("__local_cookies");
  });

  // Bug 5: shorthand property { x } — key and value are the same AST node.
  // The old guard relied on parent being correctly threaded during recursion.
  // If the same range was hit twice, MagicString would throw. Verified by
  // checking the output is correct and no exception is thrown.
  it("regression (shorthand same-node): shorthand property expansion does not throw and produces correct output", async () => {
    const source = `
function buildAction(config) {
  const cookies = "session";
  async function submitAction(formData) {
    "use server";
    const cookies = formData.get("value");
    return { cookies };
  }
  return submitAction;
}
export const action = buildAction("cfg");
`.trimStart();

    let pluginOutput: string = source;
    await expect(async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result != null) {
        pluginOutput = typeof result === "string" ? result : result.code;
      }
    }).not.toThrow();

    // Key stays `cookies`, value becomes `__local_cookies`
    expect(pluginOutput).toContain("cookies: __local_cookies");
    expect(pluginOutput).not.toContain("__local_cookies: __local_cookies");
    expect(pluginOutput).not.toContain("{ __local_cookies }");
  });

  // -------------------------------------------------------------------------
  // Regression tests for bugs identified in bonk review (round 2)
  // -------------------------------------------------------------------------

  // Bug 1: module-level var/let/const declarations were invisible to the
  // collision detector. The !isFn branch passed ancestorNames through unchanged,
  // so Program-level declarations were never added to the ancestor set.
  it("regression (module-level var): detects collision when outer binding is a module-level declaration", async () => {
    const source = `
const cookies = "session";
export async function action(formData) {
  "use server";
  const cookies = formData.get("v");
  return cookies;
}
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // The inner `const cookies` shadows the module-level one — must be renamed
    expect(pluginOutput).toContain("__local_cookies");
    expect(pluginOutput).not.toMatch(/^\s*const cookies = formData/m);
  });

  // Bug 2: CatchClause param was unreachable dead code. The CatchClause check
  // lived inside the isFn branch, but CatchClause is not a function node so it
  // took the !isFn path which returned early without ever reaching the check.
  it("regression (catch binding): detects collision when outer binding is a catch clause param", async () => {
    const source = `
function outer() {
  try {} catch (cookies) {
    async function action(fd) {
      "use server";
      const cookies = fd.get("v");
      return cookies;
    }
    return action;
  }
}
export const act = outer();
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // catch (cookies) is an ancestor binding — must be detected and renamed
    expect(pluginOutput).toContain("__local_cookies");
  });

  // Bug 3: namesForChildren was built with pre-rename names. After renamingWalk
  // renamed `cookies` → `__local_cookies` in an outer server function, `cookies`
  // was still in namesForChildren, causing nested server functions to see it as
  // an ancestor name and spuriously rename their own independent `cookies`.
  it("regression (pre-rename false positive): nested server function with same-named local is not spuriously renamed", async () => {
    const source = `
function outer(config) {
  const cookies = "session";
  async function outerAction(fd) {
    "use server";
    const cookies = fd.get("outer");
    async function innerAction(fd2) {
      "use server";
      const cookies = fd2.get("inner");
      return cookies;
    }
    return innerAction;
  }
  return outerAction;
}
export const action = outer("cfg");
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // outerAction's `const cookies` collides with the outer `const cookies = "session"`
    // and must be renamed.
    expect(pluginOutput).toContain("__local_cookies");

    // innerAction's `const cookies` does NOT shadow any ancestor name after the
    // rename — the original `cookies` binding is removed from the ancestor set
    // and replaced with `__local_cookies`, so innerAction's own `const cookies`
    // no longer collides and must be left alone.
    expect(pluginOutput).not.toContain("__local___local_cookies");

    // innerAction's body must still use `cookies`, not `__local_cookies`
    const innerActionMatch = pluginOutput.match(
      /async function innerAction\(fd2\)[\s\S]*?return \w+;\s*\n\s*\}/,
    );
    expect(innerActionMatch).not.toBeNull();
    expect(innerActionMatch![0]).toContain("const cookies");
    expect(innerActionMatch![0]).not.toContain("const __local_cookies");
    expect(innerActionMatch![0]).toContain("return cookies");
  });

  // Bug 4: the non-server-function branch only scanned top-level bodyStmts for
  // VariableDeclaration, missing `var` declarations hoisted from inside
  // if/for/while/try blocks. collectAllDeclaredNames now handles this.
  it("regression (hoisted var in non-server fn): detects collision when outer var is inside a block", async () => {
    const source = `
function buildAction(config) {
  if (config) {
    var cookies = "session";
  }
  async function action(fd) {
    "use server";
    const cookies = fd.get("v");
    return cookies;
  }
  return action;
}
export const act = buildAction("cfg");
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // `var cookies` is function-scoped and visible to `action` — must be detected
    expect(pluginOutput).toContain("__local_cookies");
    expect(pluginOutput).not.toMatch(/^\s*const cookies = fd\.get/m);
  });

  // Bug 1 (round 3): collectAllDeclaredNames stopped at FunctionDeclaration
  // without recording node.id.name. A `function cookies() {}` at module or
  // function scope creates a binding named `cookies` in the enclosing scope,
  // but the plugin never added it to namesForChildren, so the collision with
  // a same-named `const cookies` inside a 'use server' action was invisible.
  it("regression (FunctionDeclaration name): detects collision when outer binding is a function declaration", async () => {
    const source = `
function cookies() { return "session"; }
export async function action(formData) {
  "use server";
  const cookies = formData.get("v");
  return cookies;
}
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // The function declaration `cookies` is a binding in module scope —
    // the action's `const cookies` must be renamed to avoid the duplicate.
    expect(pluginOutput).toContain("__local_cookies");
    expect(pluginOutput).not.toMatch(/^\s*const cookies = formData/m);
  });

  // Bug 2 (round 3): collectAllDeclaredNames crossed into if/for/while blocks
  // and added block-scoped let/const to namesForChildren.  A `const cookies`
  // inside an if block is NOT visible to a sibling function declaration, so it
  // must not trigger a rename of that function's own `const cookies`.
  it("regression (block-scoped let/const false positive): does not rename when collision is only with a block-scoped sibling let/const", async () => {
    const source = `
function buildAction(config) {
  async function action(fd) {
    "use server";
    const cookies = fd.get("v");
    return cookies;
  }
  if (config) {
    const cookies = "value";
  }
  return action;
}
export const act = buildAction("cfg");
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // The `const cookies` inside the if block is block-scoped and not visible
    // to `action` — the plugin must leave `action`'s `const cookies` alone.
    expect(pluginOutput).not.toContain("__local_cookies");
    expect(pluginOutput).toContain("const cookies = fd.get");
  });

  it("fix (param collision): detects collision when outer binding is a function parameter, not a var declaration", async () => {
    // collectOuterNames previously only walked VariableDeclaration nodes.
    // A parameter like `function buildAction(cookies)` is also a binding that
    // periscopic tracks, so it must also be collected as an outer name.
    const source = `
function buildAction(cookies) {
  async function submitAction(formData) {
    "use server";
    const cookies = formData.get("value");
    return cookies;
  }
  return submitAction;
}
export const action = buildAction("session");
`.trimStart();

    const output = await runPipeline(source);

    // The inner `const cookies` must be renamed — no duplicate declaration
    const duplicateCount = countMatches(output, /\bconst cookies\b/g);
    expect(
      duplicateCount,
      `expected at most 1 'const cookies' after fix, got ${duplicateCount}:\n${output}`,
    ).toBeLessThanOrEqual(1);
    expect(output).toContain("__local_cookies");
  });

  it("fix (member expression): does not rename non-computed member expression properties", async () => {
    // renamingWalk previously renamed every matching Identifier unconditionally.
    // `formData.cookies` has an Identifier node for `cookies` as the property
    // of a MemberExpression — that should NOT be renamed to `formData.__local_cookies`.
    const source = `
function buildAction(config) {
  const cookies = "session";
  async function submitAction(formData) {
    "use server";
    const cookies = formData.cookies + ":" + config;
    return cookies;
  }
  return submitAction;
}
export const action = buildAction("cfg");
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // The member expression property must be untouched
    expect(pluginOutput).toContain("formData.cookies");
    expect(pluginOutput).not.toContain("formData.__local_cookies");

    // The local declaration and its usages are renamed
    expect(pluginOutput).toContain("__local_cookies");
  });

  it("fix (shorthand property): expands shorthand object properties that use the colliding name", async () => {
    // { cookies } is shorthand for { cookies: cookies }.  renamingWalk must
    // expand it to { cookies: __local_cookies } — renaming only the value,
    // not the key — so the object shape is preserved.
    const source = `
function buildAction(config) {
  const cookies = "session";
  async function submitAction(formData) {
    "use server";
    const cookies = formData.get("value");
    return { cookies };
  }
  return submitAction;
}
export const action = buildAction("cfg");
`.trimStart();

    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // Shorthand must be expanded: key stays `cookies`, value becomes `__local_cookies`
    expect(pluginOutput).toContain("cookies: __local_cookies");
    // Must NOT have renamed the key itself
    expect(pluginOutput).not.toContain("__local_cookies: __local_cookies");
    expect(pluginOutput).not.toContain("{ __local_cookies }");
  });

  it("fix (nested traversal): visits nested 'use server' functions inside a server function with no collisions", async () => {
    // When isServerFn=true and localDecls.size > 0 but collisions.size === 0,
    // the old code fell through to `if (!isServerFn)` which was false, so
    // children were never visited. A nested 'use server' function would be missed.
    const source = `
function outer(config) {
  const unrelated = "x";
  async function outerAction(formData) {
    "use server";
    // no collision with outer scope here — but contains a nested action
    const value = formData.get("v");
    async function innerAction(fd) {
      "use server";
      const config = fd.get("cfg");
      return config;
    }
    return { value, innerAction };
  }
  return outerAction;
}
export const action = outer("cfg");
`.trimStart();

    // The inner action has `const config` which shadows the outer `config` param.
    // The fix must still reach and fix the innerAction even though outerAction
    // itself has local decls (unrelated) but no collisions.
    const pluginOutput = await (async () => {
      const plugin = getCollisionPlugin();
      if (!plugin?.transform) return source;
      const transform = unwrapHook(plugin.transform);
      const result = await transform.call(plugin, source, "/app/actions/page.tsx");
      if (result == null) return source;
      return typeof result === "string" ? result : result.code;
    })();

    // innerAction's `const config` must be renamed
    expect(pluginOutput).toContain("__local_config");
  });
});
