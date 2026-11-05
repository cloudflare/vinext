import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  blankDefineDeadRequires,
  literalDefines,
} from "../packages/vinext/src/plugins/commonjs-dead-requires.js";

type CommonJsTransform = (code: string, id: string) => Promise<{ code: string } | null | undefined>;

const require = createRequire(path.join(import.meta.dirname, "../packages/vinext/package.json"));
const ID = path.join(import.meta.dirname, "fixtures/instrumentation.js");

/** The real vite-plugin-commonjs transform, with its filter accepting every id. */
function createCommonJsTransform(): CommonJsTransform {
  const commonjs = require("vite-plugin-commonjs").default;
  const plugin = commonjs({ filter: () => true });
  plugin.configResolved({
    root: import.meta.dirname,
    resolve: { alias: [], extensions: [".js"] },
    optimizeDeps: {},
    logger: console,
    createResolver: () => async () => undefined,
  });
  return (code, id) => plugin.transform(code, id);
}

const SERVER_DEFINES = literalDefines({
  "process.env.NEXT_RUNTIME": '"nodejs"',
  "process.env.NODE_ENV": '"production"',
  "process.env.NEXT_PHASE": "globalThis.__VINEXT_NEXT_PHASE",
  "typeof window": '"undefined"',
});

function blank(code: string, definesEveryModule = true): string {
  return blankDefineDeadRequires(code, ID, SERVER_DEFINES, definesEveryModule)?.toString() ?? code;
}

describe("blankDefineDeadRequires", () => {
  // Ported from Next.js: test/e2e/instrumentation-hook/with-node-page/instrumentation.js
  // https://github.com/vercel/next.js/blob/canary/test/e2e/instrumentation-hook/with-node-page/instrumentation.js
  const withNodePage = `export function register() {
  if (process.env.NEXT_RUNTIME === 'edge') {
    console.log('instrumentation hook on the edge')
  } else if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('instrumentation hook on nodejs')
  } else {
    require('this should fail')
  }
}
`;

  it("keeps vite-plugin-commonjs from hoisting a require() the NEXT_RUNTIME define makes dead", async () => {
    const blanked = blank(withNodePage);
    expect(blanked).toBe(withNodePage.replace("require('this should fail')", "0".padEnd(27)));
    // Nothing is left for vite-plugin-commonjs to hoist.
    expect(await createCommonJsTransform()(blanked, ID)).toBeUndefined();
  });

  // Based on Next.js: test/e2e/instrumentation-hook/with-async-node-page/instrumentation.js
  const instrumentation = `export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    console.log("instrumentation hook on the edge");
  } else if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("instrumentation hook on nodejs");
    require("./instrumentation.node");
  } else {
    await require("this should fail");
  }
}
`;

  it("still hoists the require() calls of the branch the define keeps live", async () => {
    const blanked = blank(instrumentation);
    expect(blanked).toHaveLength(instrumentation.length);
    expect(blanked).not.toContain("this should fail");

    const transformed = await createCommonJsTransform()(blanked, ID);
    expect(transformed?.code).toContain('from "./instrumentation.node"');
    expect(transformed?.code).not.toContain("this should fail");
  });

  it("blanks the branch the client's NEXT_RUNTIME value makes dead instead", () => {
    // On the client, NEXT_RUNTIME is "" and the final else branch runs.
    const client = literalDefines({ "process.env.NEXT_RUNTIME": '""' });
    const deadCall = 'require("./instrumentation.node")';
    expect(blankDefineDeadRequires(instrumentation, ID, client, true)?.toString()).toBe(
      instrumentation.replace(deadCall, "0".padEnd(deadCall.length)),
    );
  });

  it("preserves offsets and line breaks", () => {
    const code = `if (process.env.NODE_ENV !== "production") {\n  require\n  (\n    "./dev-only"\n  );\n}\nfoo();\n`;
    const blanked = blank(code);
    expect(blanked).toHaveLength(code.length);
    expect(blanked.split("\n")).toHaveLength(code.split("\n").length);
    expect(blanked).not.toContain("dev-only");
  });

  it("folds conditional and logical expressions", () => {
    const code = [
      `const a = process.env.NEXT_RUNTIME === "edge" ? require("edge-a") : null;`,
      `const b = process.env.NEXT_RUNTIME !== "nodejs" && require("edge-b");`,
      `const c = process.env.NEXT_RUNTIME === "nodejs" || require("edge-c");`,
      `const d = !(process.env.NEXT_RUNTIME == "nodejs") ? require("edge-d") : null;`,
      `if (typeof window !== "undefined") require("browser-only");`,
    ].join("\n");
    const blanked = blank(code);
    for (const specifier of ["edge-a", "edge-b", "edge-c", "edge-d", "browser-only"]) {
      expect(blanked).not.toContain(specifier);
    }
  });

  it("folds conditions a define decides whatever their other operand is", () => {
    const code = [
      `if (enabled && process.env.NODE_ENV !== "production") require("dev-a");`,
      `if (!(enabled || process.env.NODE_ENV === "production")) require("dev-b");`,
      `const c = enabled && process.env.NODE_ENV !== "production" ? require("dev-c") : null;`,
      `if (process.env.NODE_ENV === "production" || enabled) {} else require("dev-d");`,
    ].join("\n");
    const blanked = blank(code);
    for (const specifier of ["dev-a", "dev-b", "dev-c", "dev-d"]) {
      expect(blanked).not.toContain(specifier);
    }
  });

  it("folds statically computed member access to a define", () => {
    const code = [
      `if (process.env["NEXT_RUNTIME"] === "edge") require("edge-a");`,
      `if (process["env"].NEXT_RUNTIME === "edge") require("edge-b");`,
    ].join("\n");
    const blanked = blank(code);
    for (const specifier of ["edge-a", "edge-b"]) {
      expect(blanked).not.toContain(specifier);
    }
  });

  it("folds computed member access in unbundled dev only when Vite does", () => {
    // Vite's dev define transform skips server modules that never spell a key
    // with dots, so this condition reads the real process.env at runtime.
    const computedOnly = `if (process.env["NEXT_RUNTIME"] === "edge") require("edge-only");\n`;
    expect(blank(computedOnly, false)).toBe(computedOnly);
    // Once a dotted key matches, Vite folds every spelling in the module.
    const withDotted = `${computedOnly}if (process?.env.NODE_ENV === "test") require("test-only");\n`;
    const blanked = blank(withDotted, false);
    expect(blanked).not.toContain("edge-only");
    expect(blanked).not.toContain("test-only");
  });

  it("folds raw primitive define values that Vite serializes", () => {
    const defines = literalDefines({ __DEV__: false, __COUNT__: 0, __NIL__: null });
    const code = [
      `if (__DEV__) require("dev-only");`,
      `if (__COUNT__ === 1) require("count-one");`,
      `const nil = __NIL__ !== null && require("nil-fallback");`,
    ].join("\n");
    const blanked = blankDefineDeadRequires(code, ID, defines, true)?.toString();
    for (const specifier of ["dev-only", "count-one", "nil-fallback"]) {
      expect(blanked).not.toContain(specifier);
    }
  });

  it("leaves require() calls whose condition is not a literal define", () => {
    const code = [
      `if (process.env.NEXT_PHASE === "phase-production-build") require("phase");`,
      `if (process.env.UNKNOWN === "x") require("unknown");`,
      `if (globalThis.Bun) require("bun-only"); else require("node-only");`,
      `if (process.env[runtimeKey] === "edge") require("dynamic-key");`,
      `if (enabled && process.env.NODE_ENV === "production") require("prod-a");`,
      `if (enabled || process.env.NODE_ENV !== "production") require("prod-b");`,
      `const c = (enabled && process.env.NODE_ENV === "production") ?? require("nullish");`,
    ].join("\n");
    expect(blankDefineDeadRequires(code, ID, SERVER_DEFINES, true)).toBeNull();
  });

  it("does not fold a define key whose root is a local binding", () => {
    const code = `function load(process) {
  if (process.env.NEXT_RUNTIME === "edge") return require("edge-only");
}
`;
    expect(blankDefineDeadRequires(code, ID, SERVER_DEFINES, true)).toBeNull();
  });
});
