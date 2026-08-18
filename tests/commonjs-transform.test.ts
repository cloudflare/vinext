import { describe, expect, it } from "vite-plus/test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { toSlash } from "pathslash";
import type { Alias } from "vite";
import {
  createCommonJsPlugin,
  transformCommonJs,
} from "../packages/vinext/src/plugins/commonjs.js";

async function runPluginTransform(code: string, id: string, aliases: Alias[] = []) {
  const plugin = createCommonJsPlugin();
  const configResolved = plugin.configResolved;
  if (typeof configResolved !== "function") throw new Error("Expected configResolved hook");
  await configResolved.call(
    {} as never,
    {
      root: import.meta.dirname,
      resolve: {
        alias: aliases,
        extensions: [".mjs", ".js", ".cjs", ".mts", ".ts", ".cts", ".jsx", ".tsx", ".json"],
      },
    } as never,
  );
  const hook = plugin.transform;
  if (!hook || typeof hook === "function") throw new Error("Expected object transform hook");
  return await hook.handler.call(
    {
      addWatchFile() {},
      environment: { mode: "dev", config: { consumer: "server" } },
    } as never,
    code,
    id,
  );
}

async function evaluateCommonJs(code: string): Promise<Record<string, unknown>> {
  const result = transformCommonJs(code, "/app/value.js");
  if (!result) throw new Error("Expected transformed code");
  const url = `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`;
  return import(url) as Promise<Record<string, unknown>>;
}

describe("transformCommonJs", () => {
  it("hoists literal require calls with the existing default-first interop", () => {
    const result = transformCommonJs(
      `const { join } = require("node:path");\nexport const value = join("a", "b");`,
      "/app/page.tsx",
    );
    expect(result?.code).toContain('import * as __vinext_cjs_import__ from "node:path";');
    expect(result?.code).toContain(
      `const { join } = (__vinext_cjs_import__.default || __vinext_cjs_import__);`,
    );
  });

  it("transforms dependency CommonJS modules selected by the plugin", async () => {
    const result = await runPluginTransform(
      `const value = require("dependency"); module.exports = value;`,
      "/app/node_modules/example/index.js",
    );
    if (!result || typeof result === "string" || !("code" in result)) {
      throw new Error("Expected transformed dependency code");
    }
    expect(String(result.code)).toContain('from "dependency"');
    expect(String(result.code)).toContain("__vinext_cjs_default__ as default");
  });

  // Ported from vite-plugin-commonjs v0.10.4 historical require-form coverage:
  // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/test/fixtures/v0.4.7/input.js
  it("rewrites repeated requires in side-effect, member, and collection positions", () => {
    const result = transformCommonJs(
      `
require("foo");
require("foo").bar();
const foo = require("foo");
const fooDefault = require("foo").default;
const { value } = require("foo");
const routes = [{ component: require("@/views/home.vue") }];
export { foo, fooDefault, value, routes };
`,
      "/app/value.js",
    );
    expect(result?.code.match(/from "foo"/g)).toHaveLength(1);
    expect(result?.code.match(/from "@\/views\/home\.vue"/g)).toHaveLength(1);
    expect(result?.code).toContain(".bar();");
    expect(result?.code).toContain(".default;");
    expect(result?.code).toContain("const { value }");
  });

  it("exposes module.exports as the default export", () => {
    const result = transformCommonJs(`module.exports = () => "cjs";`, "/app/value.js");
    expect(result?.code).toContain("var module = { exports: {} };");
    expect(result?.code).toContain("__vinext_cjs_default__ as default");
  });

  it("exposes statically named exports", () => {
    const result = transformCommonJs(
      `exports.Component = () => "component";\nmodule.exports.value = 42;`,
      "/app/value.js",
    );
    expect(result?.code).toContain("__vinext_cjs_export_Component__ as Component");
    expect(result?.code).toContain("__vinext_cjs_export_value__ as value");
  });

  // Ported from vite-plugin-commonjs v0.10.4:
  // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/test/fixtures/src/cjs.js
  it("evaluates guarded module and exports reassignment", async () => {
    const module = await evaluateCommonJs(`
if (typeof exports !== "undefined") {
  if (typeof module !== "undefined" && module.exports) {
    exports = module.exports = { cjs: "cjs" };
  }
}
`);
    expect(module.default).toEqual({ cjs: "cjs" });
  });

  // Ported from vite-plugin-commonjs v0.10.4 historical export fixtures:
  // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/test/fixtures/v0.4.0/input.js
  it("evaluates repeated and nested named export assignments", async () => {
    const module = await evaluateCommonJs(`
exports.foo = "first";
exports.foo = "foo";
function assignNestedExport() {
  exports.bar = exports.foo;
}
assignNestedExport();
exports.obj = { foo: "foo" };
`);
    expect(module.default).toEqual({ foo: "foo", bar: "foo", obj: { foo: "foo" } });
    expect(module.foo).toBe("foo");
    expect(module.bar).toBe("foo");
    expect(module.obj).toEqual({ foo: "foo" });
  });

  // Ported from vite-plugin-commonjs v0.10.4's unrestricted named-export generation:
  // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/src/generate-export.ts
  it("exposes Unicode identifier names as named exports", async () => {
    const module = await evaluateCommonJs(`exports.π = 3; exports.你好 = 4;`);
    expect(module.π).toBe(3);
    expect(module.你好).toBe(4);
  });

  it("supports computed static export names but not invalid ESM names", () => {
    const result = transformCommonJs(
      `exports["valid"] = 1; exports["not-valid"] = 2;`,
      "/app/value.js",
    );
    expect(result?.code).toContain("__vinext_cjs_export_valid__ as valid");
    expect(result?.code).not.toContain("not-valid as");
  });

  it("recognises computed module exports and comments before require calls", () => {
    const result = transformCommonJs(
      `module["exports"] = require /* keep this comment */ ("value");`,
      "/app/value.js",
    );
    expect(result?.code).toContain('from "value"');
    expect(result?.code).toContain("__vinext_cjs_default__ as default");
  });

  it("does not rewrite shadowed CommonJS bindings", () => {
    const source = `
const require = (value) => value;
const module = { exports: {} };
const exports = {};
require("local");
module.exports = "local";
exports.value = "local";
`;
    expect(transformCommonJs(source, "/app/value.js")).toBeNull();
  });

  it("honors function and block scope shadowing", () => {
    const source = `
function local(require) { return require("local"); }
{
  const exports = {};
  exports.value = 1;
}
const external = require("external");
`;
    const result = transformCommonJs(source, "/app/value.ts");
    expect(result?.code).toContain('require("local")');
    expect(result?.code).toContain("exports.value = 1");
    expect(result?.code).toContain('from "external"');
  });

  it("uses collision-safe helper bindings", () => {
    const result = transformCommonJs(
      `const __vinext_cjs_import__ = 1; const value = require("value");`,
      "/app/value.js",
    );
    expect(result?.code).toContain('import * as __vinext_cjs_import___1 from "value";');
    expect(result?.code).toContain("(__vinext_cjs_import___1.default || __vinext_cjs_import___1)");
  });

  // Ported from vite-plugin-commonjs v0.10.4, which reads the first require argument
  // without rejecting additional arguments:
  // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/src/generate-import.ts
  it("ignores additional require arguments", () => {
    for (const source of [`require("value", "ignored");`, `require(\`value\`, "ignored");`]) {
      const result = transformCommonJs(source, "/app/value.js");
      expect(result?.code).toContain('from "value"');
      expect(result?.code).not.toContain("ignored");
    }
  });

  it("parses TypeScript and JSX source", () => {
    const result = transformCommonJs(
      `const value = require("value") as { default: string }; export default <p>{value.default}</p>;`,
      "/app/page.tsx",
    );
    expect(result?.code).toContain('from "value"');
  });

  it("leaves dynamic and non-CommonJS modules unchanged", () => {
    expect(
      transformCommonJs(`require(\`./messages/${"${locale}"}.js\`);`, "/app/page.js"),
    ).toBeNull();
    expect(transformCommonJs(`export default 42;`, "/app/page.js")).toBeNull();
  });

  it("expands patterned dynamic requires with Node's glob implementation", async () => {
    const importer = path.join(
      import.meta.dirname,
      "fixtures/pages-basic/pages/cjs/dynamic-require.tsx",
    );
    const result = await runPluginTransform(
      `const messages = require(\`../../locales/${"${locale}"}.js\`);`,
      importer,
    );
    if (!result || typeof result === "string" || !("code" in result)) {
      throw new Error("Expected transformed code");
    }
    const transformed = String(result.code);
    expect(transformed).toContain('from "../../locales/en.js"');
    expect(transformed).toContain('from "../../locales/ru.js"');
    expect(transformed).toContain('case "../../locales/ru.js"');
    expect(transformed).toContain("__vinext_dynamic_require__(`../../locales/${locale}.js`)");
  });

  it("expands concatenated dynamic require patterns", async () => {
    const importer = path.join(
      import.meta.dirname,
      "fixtures/pages-basic/pages/cjs/dynamic-require.tsx",
    );
    for (const expression of [
      '"../../locales/" + locale + ".js"',
      '"../../locales/".concat(locale, ".js")',
    ]) {
      const result = await runPluginTransform(`const messages = require(${expression});`, importer);
      if (!result || typeof result === "string" || !("code" in result)) {
        throw new Error("Expected transformed code");
      }
      const transformed = String(result.code);
      expect(transformed).toContain('from "../../locales/ru.js"');
      expect(transformed).toContain('case "../../locales/ru.js"');
    }
  });

  it("expands aliased dynamic require patterns", async () => {
    const importer = path.join(
      import.meta.dirname,
      "fixtures/pages-basic/pages/cjs/dynamic-require.tsx",
    );
    const replacement = path.join(import.meta.dirname, "fixtures/pages-basic/locales");
    const result = await runPluginTransform(
      `const messages = require(\`@messages/${"${locale}"}.js\`);`,
      importer,
      [{ find: "@messages", replacement }],
    );
    if (!result || typeof result === "string" || !("code" in result)) {
      throw new Error("Expected transformed code");
    }
    const transformed = String(result.code);
    expect(transformed).toContain(JSON.stringify(path.join(replacement, "ru.js")));
    expect(transformed).toContain('case "@messages/ru.js"');
  });

  it("expands regex-aliased dynamic require patterns", async () => {
    const importer = path.join(
      import.meta.dirname,
      "fixtures/pages-basic/pages/cjs/dynamic-require.tsx",
    );
    const replacement = path.join(import.meta.dirname, "fixtures/pages-basic/locales");
    const result = await runPluginTransform(
      `const messages = require(\`@messages/${"${locale}"}.js\`);`,
      importer,
      [{ find: /^@messages/, replacement }],
    );
    if (!result || typeof result === "string" || !("code" in result)) {
      throw new Error("Expected transformed code");
    }
    const transformed = String(result.code);
    expect(transformed).toContain(JSON.stringify(path.join(replacement, "ru.js")));
    expect(transformed).toContain('case "@messages/ru.js"');
  });

  // Ported from vite-plugin-commonjs v0.10.4 and its transitive dynamic-import fixture:
  // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/test/fixtures/src/dynamic.tsx
  // https://github.com/vite-plugin/vite-plugin-dynamic-import/blob/v1.6.0/test/fixtures/src/main.ts
  it("expands alias-root patterns whose variables include directories or extensions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-alias-root-"));
    try {
      const sourceDirectory = path.join(root, "src");
      await Promise.all([
        mkdir(path.join(sourceDirectory, "module-exports"), { recursive: true }),
        mkdir(path.join(sourceDirectory, "views/baz"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(sourceDirectory, "module-exports/hello.cjs"),
          'module.exports = "hello";\n',
        ),
        writeFile(
          path.join(sourceDirectory, "views/baz/index.tsx"),
          'export const value = "baz";\n',
        ),
      ]);
      const importer = path.join(sourceDirectory, "main.ts");
      const aliases: Alias[] = [{ find: "@", replacement: sourceDirectory }];

      const extensionResult = await runPluginTransform(
        `const value = require(\`@/module-exports/${"${name}"}\`);`,
        importer,
        aliases,
      );
      if (!extensionResult || typeof extensionResult === "string" || !("code" in extensionResult)) {
        throw new Error("Expected transformed code");
      }
      expect(String(extensionResult.code)).toContain('case "@/module-exports/hello.cjs"');

      const directoryResult = await runPluginTransform(
        `const value = require(\`@/${"${id}"}\`);`,
        importer,
        aliases,
      );
      if (!directoryResult || typeof directoryResult === "string" || !("code" in directoryResult)) {
        throw new Error("Expected transformed code");
      }
      const transformed = String(directoryResult.code);
      expect(transformed).toContain('case "@/views/baz"');
      expect(transformed).toContain('case "@/views/baz/index"');
      expect(transformed).toContain('case "@/views/baz/index.tsx"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches extensionless dynamic requires recursively", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-loose-pattern-"));
    try {
      await mkdir(path.join(root, "views/nested"), { recursive: true });
      await Promise.all([
        writeFile(path.join(root, "views/flat.js"), 'module.exports = "flat";\n'),
        writeFile(path.join(root, "views/nested/index.js"), 'module.exports = "nested";\n'),
      ]);
      const result = await runPluginTransform(
        `const view = require(\`./views/${"${name}"}\`);`,
        path.join(root, "page.js"),
      );
      if (!result || typeof result === "string" || !("code" in result)) {
        throw new Error("Expected transformed code");
      }
      const transformed = String(result.code);
      expect(transformed).toContain('case "./views/flat"');
      expect(transformed).toContain('case "./views/flat.js"');
      expect(transformed).toContain('case "./views/nested"');
      expect(transformed).toContain('case "./views/nested/index"');
      expect(transformed).toContain('case "./views/nested/index.js"');
      expect(transformed).not.toContain('from "./views/nested";');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches extensionless dynamic asset requires", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-asset-pattern-"));
    try {
      await mkdir(path.join(root, "assets"), { recursive: true });
      await writeFile(path.join(root, "assets/logo.png"), "fixture");
      const result = await runPluginTransform(
        `const asset = require(\`./assets/${"${name}"}\`);`,
        path.join(root, "page.js"),
      );
      if (!result || typeof result === "string" || !("code" in result)) {
        throw new Error("Expected transformed code");
      }
      const transformed = String(result.code);
      expect(transformed).toContain('from "./assets/logo.png"');
      expect(transformed).toContain('case "./assets/logo"');
      expect(transformed).toContain('case "./assets/logo.png"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expands bare-package dynamic require patterns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-pattern-"));
    try {
      const packageDirectory = path.join(root, "node_modules/messages");
      await mkdir(packageDirectory, { recursive: true });
      await Promise.all([
        writeFile(path.join(packageDirectory, "package.json"), '{"name":"messages"}\n'),
        writeFile(path.join(packageDirectory, "ru.js"), 'module.exports = "loaded";\n'),
      ]);
      const result = await runPluginTransform(
        `const messages = require(\`messages/${"${locale}"}.js\`);`,
        path.join(root, "page.js"),
      );
      if (!result || typeof result === "string" || !("code" in result)) {
        throw new Error("Expected transformed code");
      }
      const transformed = String(result.code);
      expect(transformed).toContain(
        JSON.stringify(path.join(toSlash(await realpath(packageDirectory)), "ru.js")),
      );
      expect(transformed).toContain('case "messages/ru.js"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Ported from vite-plugin-dynamic-import v1.6.0 bare-package resolution coverage:
  // https://github.com/vite-plugin/vite-plugin-dynamic-import/blob/v1.6.0/test/resolve.test.ts
  it("expands scoped bare-package dynamic require patterns", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-scoped-pattern-"));
    try {
      const packageDirectory = path.join(root, "node_modules/@scope/messages");
      await mkdir(packageDirectory, { recursive: true });
      await Promise.all([
        writeFile(path.join(packageDirectory, "package.json"), '{"name":"@scope/messages"}\n'),
        writeFile(path.join(packageDirectory, "ru.js"), 'module.exports = "loaded";\n'),
      ]);
      const result = await runPluginTransform(
        `const messages = require(\`@scope/messages/${"${locale}"}\`);`,
        path.join(root, "page.js"),
      );
      if (!result || typeof result === "string" || !("code" in result)) {
        throw new Error("Expected transformed code");
      }
      const transformed = String(result.code);
      expect(transformed).toContain('case "@scope/messages/ru"');
      expect(transformed).toContain('case "@scope/messages/ru.js"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
