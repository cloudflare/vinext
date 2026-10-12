import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseAst } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  _mayContainRequireContextCall,
  createRequireContextPlugin,
} from "../packages/vinext/src/plugins/require-context.js";

// Spy on the plugin's parser so the prescan tests can assert the parse is skipped.
vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>();
  return { ...actual, parseAst: vi.fn(actual.parseAst) };
});

const importerId = path.resolve(
  import.meta.dirname,
  "./fixtures/app-basic/app/nextjs-compat/require-context/page.tsx",
);

function createTransform(): (code: string, id: string) => Promise<{ code: string } | null> {
  const plugin = createRequireContextPlugin();
  const hook = plugin.transform;
  const handler = typeof hook === "function" ? hook : hook?.handler;
  // The handler keys per-environment state and registers directory watchers;
  // give it the minimal plugin context those two calls need.
  const context = { environment: {}, addWatchFile: () => {} };
  return handler!.bind(context as never) as never;
}

describe("vinext:require-context", () => {
  it("emits static imports only for modules accepted by the regexp", async () => {
    const transform = createTransform();
    const result = await transform(
      `const ctx = require.context("./filtered", false, /\\.safe\\.js$/);`,
      importerId,
    );

    expect(result?.code).toContain('from "./filtered/included.safe.js"');
    expect(result?.code).not.toContain("excluded.js");
    expect(result?.code).toContain('["./included.safe.js"]');
  });

  it("inserts generated imports after the directive prologue", async () => {
    const transform = createTransform();
    const source = `"use client";\nconst ctx = require.context("./filtered", false, /\\.safe\\.js$/);`;
    const result = await transform(source, importerId);

    const code = result!.code;
    expect(code.indexOf('"use client"')).toBeLessThan(code.indexOf("import * as "));
  });

  it("avoids colliding with existing identifiers when generating import bindings", async () => {
    const transform = createTransform();
    const source = [
      `const __vinext_require_context_0_0 = 1;`,
      `const ctx = require.context("./filtered", false, /\\.safe\\.js$/);`,
      `export { ctx, __vinext_require_context_0_0 };`,
    ].join("\n");
    const result = await transform(source, importerId);

    const code = result!.code;
    expect(code).not.toMatch(/import \* as __vinext_require_context_0_0 /);
    // Redeclaring the user's binding would make the module fail to parse.
    expect(() => parseAst(code)).not.toThrow();
  });

  it("traverses symlinked directories in recursive contexts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-require-context-"));
    try {
      await mkdir(path.join(root, "target/sub"), { recursive: true });
      await writeFile(path.join(root, "target/sub/deep.js"), "export default 1;\n");
      await mkdir(path.join(root, "context"));
      await symlink(path.join(root, "target"), path.join(root, "context/link"));
      await symlink(path.join(root, "target"), path.join(root, "context/alias"));
      // A cycle back into the context itself must terminate, not recurse forever.
      await symlink(path.join(root, "context"), path.join(root, "target/loop"));
      // A self-referential symlink (stat -> ELOOP) must be skipped, not throw.
      await symlink(path.join(root, "context/self"), path.join(root, "context/self"));

      const transform = createTransform();
      const result = await transform(
        `const ctx = require.context("./context", true, /\\.js$/);`,
        path.join(root, "page.tsx"),
      );

      // Distinct symlink aliases of one target each keep their own keys.
      expect(result?.code).toContain('"./link/sub/deep.js"');
      expect(result?.code).toContain('"./alias/sub/deep.js"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("pre-parse call prescan", () => {
    // Every call form the parser accepts and the transform rewrites must pass
    // the prescan, or the call would silently stay untransformed.
    it.each([
      ["a TS-cast callee", `(require as any).context("./filtered")`],
      ["a single-quoted directory", `require.context('./filtered')`],
      ["comments and newlines", `require . /* a */ context /* b */ ( // c\n "./filtered")`],
      ["a line comment after the dot", `require. // c\n context("./filtered")`],
      ["a comment inside the call", `require.context?./* a */(/* b */ "./filtered")`],
      ["an optional call", `require.context?.("./filtered")`],
      ["a parenthesized optional call", `(require.context)?.("./filtered")`],
      ["parenthesized callee and argument", `((require.context))(("./filtered"))`],
      ["type arguments", `require.context<any>("./filtered")`],
      ["a non-null callee object", `(require!).context("./filtered")`],
      ["a satisfies callee object", `(require satisfies unknown).context("./filtered")`],
      ["a \\uXXXX-escaped property", `require.cont\\u0065xt("./filtered")`],
      ["an uppercase hex escape", `require.c\\u006Fntext("./filtered")`],
      ["a \\u{X}-escaped property", `require.\\u{063}ontext("./filtered")`],
      ["a U+2028 separator", `require.context\u2028("./filtered")`],
      ["a U+FEFF separator", `require.context\uFEFF("./filtered")`],
      ["a U+0085 separator", `require.\u0085context("./filtered")`],
      ["a U+200B separator", `require.context\u200B("./filtered")`],
      ["an HTML open comment", `require.context <!-- c\n("./filtered")`],
      ["an HTML close comment", `require.context\n--> c\n("./filtered")`],
      ["an HTML comment after the dot", `require.\n--> c\ncontext("./filtered")`],
    ])("still transforms a call with %s", async (_name, call) => {
      expect(_mayContainRequireContextCall(call)).toBe(true);
      vi.mocked(parseAst).mockClear();
      const result = await createTransform()(`const ctx = ${call};`, importerId);
      expect(parseAst).toHaveBeenCalled();
      expect(result?.code).toContain('from "./filtered/included.safe.js"');
    });

    it.each([
      ["a non-literal directory", `require.context(dir)`],
      ["a template-literal directory", "require.context(`./filtered`)"],
      ["a longer property name", `require.contexts("./filtered")`],
      ["an escaped longer property name", `require.context\\u0073("./filtered")`],
      ["a prefixed property name", `require.xcontext("./filtered")`],
      ["a bare context call", `context("./filtered")`],
      ["a property read", `const context = require("x").context;`],
    ])("skips parsing a module with %s", async (_name, code) => {
      expect(_mayContainRequireContextCall(code)).toBe(false);
      vi.mocked(parseAst).mockClear();
      expect(await createTransform()(code, importerId)).toBeNull();
      expect(parseAst).not.toHaveBeenCalled();
    });

    it("rejects long non-matching input in linear time", () => {
      for (const gap of [" ", ")", "\n", ")?. ", "( "]) {
        expect(_mayContainRequireContextCall(`require.context${gap.repeat(50_000)}x`)).toBe(false);
      }
      // Unterminated comments after many start candidates must not each be
      // scanned to the end of the input.
      for (const unit of [".//", "./*", ".<!--", ".-->", "context/*", "context//", "*/context"]) {
        expect(_mayContainRequireContextCall(unit.repeat(50_000))).toBe(false);
      }
    });
  });
});
