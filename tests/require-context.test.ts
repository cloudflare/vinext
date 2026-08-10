import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseAst } from "vite";
import { describe, expect, it } from "vite-plus/test";
import { createRequireContextPlugin } from "../packages/vinext/src/plugins/require-context.js";

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
});
