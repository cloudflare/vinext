import { describe, it, expect } from "vite-plus/test";
import {
  buildCjsGlobalsShimPreamble,
  cjsGlobalsShimPlugin,
  detectCjsGlobalReferences,
} from "../packages/vinext/src/plugins/cjs-globals-shim.js";

// The transform handler may live inside an object-style hook
// (`{ filter, handler }`) on Vite 8+. Resolve either shape to the
// underlying function so the tests can invoke it directly with a fake
// plugin `this` context.
function getTransformHandler(): (
  this: { environment?: { name: string } },
  code: string,
  id: string,
) => { code: string; map: null } | null | undefined {
  const transform = cjsGlobalsShimPlugin.transform;
  if (!transform) throw new Error("cjsGlobalsShimPlugin has no transform hook");
  if (typeof transform === "function") {
    return transform as unknown as (
      this: { environment?: { name: string } },
      code: string,
      id: string,
    ) => { code: string; map: null } | null | undefined;
  }
  return transform.handler as unknown as (
    this: { environment?: { name: string } },
    code: string,
    id: string,
  ) => { code: string; map: null } | null | undefined;
}

describe("detectCjsGlobalReferences", () => {
  it("returns both false when neither identifier appears", () => {
    expect(detectCjsGlobalReferences(`export const x = 1;`)).toEqual({
      __dirname: false,
      __filename: false,
    });
  });

  it("detects bare __dirname reference", () => {
    expect(detectCjsGlobalReferences(`console.log(__dirname);`)).toEqual({
      __dirname: true,
      __filename: false,
    });
  });

  it("detects bare __filename reference", () => {
    expect(detectCjsGlobalReferences(`const f = typeof __filename;`)).toEqual({
      __dirname: false,
      __filename: true,
    });
  });

  it("does not match inside strings", () => {
    expect(detectCjsGlobalReferences(`const s = "hello __dirname world";`)).toEqual({
      __dirname: false,
      __filename: false,
    });
  });

  it("does not match inside template literals (outside ${})", () => {
    expect(detectCjsGlobalReferences("const t = `text __filename inline`;")).toEqual({
      __dirname: false,
      __filename: false,
    });
  });

  it("does match inside template ${} interpolations", () => {
    // Inside `${...}` is code, not literal text — references there are real.
    expect(detectCjsGlobalReferences("const t = `pre ${__dirname} post`;")).toEqual({
      __dirname: true,
      __filename: false,
    });
  });

  it("does not match inside comments", () => {
    expect(detectCjsGlobalReferences(`// uses __dirname inside\nexport const x = 1;`)).toEqual({
      __dirname: false,
      __filename: false,
    });
    expect(detectCjsGlobalReferences(`/* __filename hint */ const x = 1;`)).toEqual({
      __dirname: false,
      __filename: false,
    });
  });

  it("detects identifiers used as object keys when bare", () => {
    expect(detectCjsGlobalReferences(`const x = { __dirname };`)).toEqual({
      __dirname: true,
      __filename: false,
    });
  });
});

describe("buildCjsGlobalsShimPreamble", () => {
  it("returns empty string when nothing is needed", () => {
    expect(buildCjsGlobalsShimPreamble({ __dirname: false, __filename: false })).toBe("");
  });

  it("emits __filename only when only __filename is needed", () => {
    const out = buildCjsGlobalsShimPreamble({ __dirname: false, __filename: true });
    expect(out).toContain(`import { fileURLToPath as __vinext_fileURLToPath } from "node:url"`);
    expect(out).toContain(`const __filename = __vinext_fileURLToPath(import.meta.url);`);
    expect(out).not.toContain("__dirname");
    expect(out).not.toContain("node:path");
  });

  it("emits __dirname only when only __dirname is needed", () => {
    const out = buildCjsGlobalsShimPreamble({ __dirname: true, __filename: false });
    expect(out).toContain(`import { dirname as __vinext_dirname } from "node:path"`);
    expect(out).toContain("const __dirname = __vinext_dirname(__vinext_fileURLToPath");
    // Should not redeclare __filename when not needed.
    expect(out).not.toMatch(/const __filename =/);
  });

  it("emits both bindings and reuses __filename for __dirname when both are needed", () => {
    const out = buildCjsGlobalsShimPreamble({ __dirname: true, __filename: true });
    expect(out).toContain(`const __filename = __vinext_fileURLToPath(import.meta.url);`);
    expect(out).toContain(`const __dirname = __vinext_dirname(__filename);`);
  });
});

describe("cjsGlobalsShimPlugin.transform", () => {
  it("skips files outside node_modules via the filter", () => {
    // Filter is enforced by Vite; when present the handler isn't invoked for
    // non-matching ids. Verify the filter shape statically.
    const transform = cjsGlobalsShimPlugin.transform;
    expect(transform).toBeTruthy();
    if (transform && typeof transform === "object") {
      expect(transform.filter?.id).toBeInstanceOf(RegExp);
      const re = transform.filter?.id as RegExp;
      expect(re.test("/repo/src/index.js")).toBe(false);
      expect(re.test("/repo/node_modules/foo/index.js")).toBe(true);
      expect(re.test("/repo/node_modules/foo/index.mjs")).toBe(true);
      expect(re.test("/repo/node_modules/foo/index.cjs")).toBe(true);
      expect(re.test("/repo/node_modules/foo/index.ts")).toBe(false);
      // Query suffix tolerated
      expect(re.test("/repo/node_modules/foo/index.js?v=abc")).toBe(true);
    }
  });

  it("returns null when called in a non-server environment", () => {
    const handler = getTransformHandler();
    const ret = handler.call(
      { environment: { name: "client" } },
      `console.log(__dirname);`,
      "/repo/node_modules/foo/index.js",
    );
    expect(ret).toBeNull();
  });

  it("returns null when source does not reference the globals", () => {
    const handler = getTransformHandler();
    const ret = handler.call(
      { environment: { name: "ssr" } },
      `export const x = 1;`,
      "/repo/node_modules/foo/index.js",
    );
    expect(ret).toBeNull();
  });

  it("prepends the shim for ssr environment", () => {
    const handler = getTransformHandler();
    const ret = handler.call(
      { environment: { name: "ssr" } },
      `console.log(__dirname, __filename);`,
      "/repo/node_modules/foo/index.js",
    );
    expect(ret).not.toBeNull();
    expect(ret?.code).toContain(`const __filename = __vinext_fileURLToPath(import.meta.url);`);
    expect(ret?.code).toContain(`const __dirname = __vinext_dirname(__filename);`);
    expect(ret?.code.endsWith(`console.log(__dirname, __filename);`)).toBe(true);
  });

  it("prepends the shim for rsc environment", () => {
    const handler = getTransformHandler();
    const ret = handler.call(
      { environment: { name: "rsc" } },
      `if (typeof __dirname === "string") {}`,
      "/repo/node_modules/lib/runtime.mjs",
    );
    expect(ret).not.toBeNull();
    expect(ret?.code).toContain(`const __dirname =`);
  });

  it("only injects what is needed (single binding)", () => {
    const handler = getTransformHandler();
    const ret = handler.call(
      { environment: { name: "ssr" } },
      `console.log(__filename);`,
      "/repo/node_modules/foo/index.js",
    );
    expect(ret?.code).toContain(`const __filename = __vinext_fileURLToPath(import.meta.url);`);
    // __dirname was not referenced, so it must not be declared.
    expect(ret?.code).not.toMatch(/const __dirname/);
    // And node:path should not be imported.
    expect(ret?.code).not.toContain(`node:path`);
  });
});
