import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { build, transformWithOxc } from "vite-plus";
import {
  COMMONJS_SYNTAX_CODE_FILTER,
  mayContainCommonJsSyntax,
} from "../packages/vinext/src/plugins/commonjs-syntax.js";

type CommonJsTransform = (code: string, id: string) => Promise<{ code: string } | null | undefined>;

const require = createRequire(path.join(import.meta.dirname, "../packages/vinext/package.json"));
const FIXTURES_DIR = path.join(import.meta.dirname, "fixtures");
const EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"];

/** The real vite-plugin-commonjs transform, with its filter accepting every id. */
function createCommonJsTransform(): CommonJsTransform {
  const commonjs = require("vite-plugin-commonjs").default;
  const plugin = commonjs({ filter: () => true });
  plugin.configResolved({
    root: FIXTURES_DIR,
    resolve: { alias: [], extensions: EXTENSIONS },
    optimizeDeps: {},
    logger: console,
    createResolver: () => async () => undefined,
  });
  return (code, id) => plugin.transform(code, id);
}

const transformCommonJs = createCommonJsTransform();

// Each case is rewritten by vite-plugin-commonjs.
const COMMONJS_SOURCES: [string, string][] = [
  ["require call", `const a = require("a");`],
  ["whitespace before the call", `require ("a");`],
  ["newline before the call", `require\n("a");`],
  ["block comment before the call", `require /* c */ ("a");`],
  ["line comment before the call", `require // c\n("a");`],
  ["parenthesized callee", `(require)("a");`],
  ["nested parenthesized callee", `( (require /* c */ ) )("a");`],
  ["optional call", `require?.("a");`],
  ["spread require call", `f(...require("a"));`],
  ["require inside a template", "`${require('a')}`;"],
  ["property access on a require call", `const b = require("a").b;`],
  ["template literal require", "const a = require(`./a`);"],
  ["unicode-escaped require", `const module = 1;\nreq\\u0075ire("a");`],
  ["exports member assignment", `exports.a = 1;`],
  ["computed exports assignment", `exports["a"] = 1;`],
  ["module.exports assignment", `module.exports = {};`],
  ["compound assignment", `exports.a += 1;`],
  ["logical assignment", `module.exports ??= {};`],
  ["newline before the member", `module\n.exports = {};`],
  ["comment before the member", `module /* c */ .exports = {};`],
  ["parenthesized object", `(\nmodule\n)\n.\nexports\n=\n{};`],
  ["nested assignment", `if (a) exports.a = 1;`],
  ["arrow body assignment", `const f = () => exports.a = 1;`],
  ["chained assignment", `const a = exports.a = 1;`],
  ["assignment inside a template", "`${exports.a = 1}`;"],
  ["spread call assignment", `f(...exports.a = 1);`],
  ["spread array assignment", `[...module.exports = {}];`],
  ["spread object assignment", `x = { ...exports.a = 1 };`],
  ["spread assignment after a comment", `f(.../* c */exports.a = 1);`],
  ["unicode-escaped module", `\\u006dodule.exports = {};`],
  ["unicode code point escape", `module;\n\\u{65}xports.a = 1;`],
];

// None of these contain syntax that vite-plugin-commonjs rewrites.
const ESM_SOURCES: [string, string][] = [
  ["plain ESM", `import a from "a";\nexport default a;`],
  [
    "require as a word in comments",
    `// require is unavailable\n/* no module exports */\nexport {};`,
  ],
  ["require without a call", `export const hasRequire = typeof require === "function";`],
  ["aliased require", `const r = require;\nr;`],
  ["require.resolve", `require.resolve("a");`],
  ["tagged template", "require`a`;"],
  ["identifier containing require", `requireAll("a"); _require("a"); $require("a");`],
  ["bare module and exports", `export default [module, exports];`],
  [
    "module and exports as properties",
    `a.module.exports = 1;\nb?.exports.c = 1;\nc\n.module.d = 1;`,
  ],
  ["identifiers containing module", `modules.a = 1;\nmyexports.a = 1;\nmodule_.a = 1;`],
  ["module as an object key", `export const a = { module: 1, exports: 2 };`],
];

function listFixtureSources(): string[] {
  return fs
    .globSync(`**/*{${EXTENSIONS.join(",")}}`, {
      cwd: FIXTURES_DIR,
      exclude: (name) =>
        ["node_modules", "dist", "out", ".vinext", ".next"].includes(path.basename(name)),
    })
    .map((file) => path.join(FIXTURES_DIR, file));
}

async function toJavaScript(file: string): Promise<string | null> {
  const code = fs.readFileSync(file, "utf8");
  const lang = path.extname(file).replace(/^\.[mc]?/, "");
  if (lang === "js") return code;
  // Vite's oxc plugin strips types and JSX before vite-plugin-commonjs runs.
  try {
    return (await transformWithOxc(code, file, { lang: lang as "jsx" | "ts" | "tsx" })).code;
  } catch {
    return null;
  }
}

/** Ids of the given modules that reach a transform filtered by the code filter in a build. */
async function transformedInBuild(sources: string[]): Promise<string[]> {
  const modules = new Map(sources.map((code, index) => [`\0module-${index}.js`, code]));
  const MODULE_ID_RE = /^\0module-/;
  const transformed: string[] = [];
  await build({
    configFile: false,
    logLevel: "silent",
    root: FIXTURES_DIR,
    build: { write: false, rolldownOptions: { input: [...modules.keys()] } },
    plugins: [
      {
        name: "test:modules",
        resolveId: (id) => (modules.has(id) ? id : null),
        load: (id) => modules.get(id),
      },
      {
        name: "test:commonjs-filter",
        enforce: "pre",
        transform: {
          filter: { id: MODULE_ID_RE, code: { include: COMMONJS_SYNTAX_CODE_FILTER } },
          handler(_code, id) {
            transformed.push(id);
          },
        },
      },
      {
        // Some sources are not valid modules on their own.
        name: "test:empty-modules",
        transform: { filter: { id: MODULE_ID_RE }, handler: () => "export {};" },
      },
    ],
  });
  return transformed.sort();
}

describe("COMMONJS_SYNTAX_CODE_FILTER", () => {
  it("selects the same modules as a native Rolldown hook filter", async () => {
    const sources = [...COMMONJS_SOURCES, ...ESM_SOURCES].map(([, code]) => code);
    const expected = sources
      .flatMap((code, index) => (mayContainCommonJsSyntax(code) ? [`\0module-${index}.js`] : []))
      .sort();

    expect(expected).toHaveLength(COMMONJS_SOURCES.length);
    expect(await transformedInBuild(sources)).toEqual(expected);
  });
});

describe("mayContainCommonJsSyntax", () => {
  it.each(COMMONJS_SOURCES)("keeps %s", async (_name, code) => {
    expect(await transformCommonJs(code, "/project/module.js")).toBeTruthy();
    expect(mayContainCommonJsSyntax(code)).toBe(true);
  });

  it.each(ESM_SOURCES)("skips %s", async (_name, code) => {
    expect(mayContainCommonJsSyntax(code)).toBe(false);
    expect(await transformCommonJs(code, "/project/module.js")).toBeFalsy();
  });

  // Runs oxc and the real plugin over every fixture module.
  it("keeps every fixture module vite-plugin-commonjs rewrites", { timeout: 30_000 }, async () => {
    const missed: string[] = [];
    let transformed = 0;
    let skipped = 0;
    for (const file of listFixtureSources()) {
      const code = await toJavaScript(file);
      if (code === null) continue;
      const kept = mayContainCommonJsSyntax(code);
      if (!kept) skipped++;
      // A module the plugin rejects (for example an unanalyzable dynamic
      // require) must reach it too, so a throw counts as a rewrite.
      const rewritten = await transformCommonJs(code, file).then(Boolean, () => true);
      if (rewritten && kept) transformed++;
      if (rewritten && !kept) missed.push(path.relative(FIXTURES_DIR, file));
    }

    expect(missed).toEqual([]);
    expect(transformed).toBeGreaterThan(0);
    expect(skipped).toBeGreaterThan(0);
  });
});
