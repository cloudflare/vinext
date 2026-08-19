import { describe, expect, it } from "vite-plus/test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { toSlash } from "pathslash";
import { createBuilder, createServer, type Alias } from "vite";
import {
  createCommonJsPlugin,
  globTraversalRoot,
  transformCommonJs,
} from "../packages/vinext/src/plugins/commonjs.js";

async function runPluginTransform(
  code: string,
  id: string,
  aliases: Alias[] = [],
  preserveSymlinks = false,
) {
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
        preserveSymlinks,
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

  // vite-plugin-commonjs uses the resolved Vite extension list to select transform inputs:
  // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/src/index.ts#L65-L68
  it("transforms CommonJS modules with custom resolve extensions", async () => {
    const root = await mkdtemp(path.join(import.meta.dirname, ".tmp-commonjs-extension-"));
    const server = await createServer({
      root,
      logLevel: "silent",
      resolve: { extensions: [".foo"] },
      plugins: [createCommonJsPlugin()],
      server: { middlewareMode: true },
    });
    try {
      await writeFile(path.join(root, "value.foo"), `module.exports = { value: "custom" };\n`);
      const module = await server.ssrLoadModule("/value.foo");
      expect(module.default).toEqual({ value: "custom" });
    } finally {
      await server.close();
    }
    try {
      await Promise.all([
        writeFile(path.join(root, "index.html"), `<script type="module" src="/main.js"></script>`),
        writeFile(
          path.join(root, "main.js"),
          `import value from "./value.foo"; globalThis.customExtensionValue = value.value;\n`,
        ),
      ]);
      const builder = await createBuilder({
        root,
        logLevel: "silent",
        resolve: { extensions: [".foo"] },
        plugins: [createCommonJsPlugin()],
        build: { write: false },
      });
      await builder.buildApp();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("preserves uninitialized top-level var redeclarations of CommonJS globals", async () => {
    const moduleRedeclaration = await evaluateCommonJs(
      `var module; module.exports = "var-module-ok";`,
    );
    expect(moduleRedeclaration.default).toBe("var-module-ok");

    const exportsRedeclaration = await evaluateCommonJs(
      `var exports; exports.value = "var-exports-ok";`,
    );
    expect(exportsRedeclaration.value).toBe("var-exports-ok");

    const requireRedeclaration = await evaluateCommonJs(
      `var require; module.exports = require("node:path").sep;`,
    );
    expect(requireRedeclaration.default).toBe(path.sep);

    const nestedModuleRedeclaration = await evaluateCommonJs(
      `if (false) { var module; } module.exports = "nested-var-module-ok";`,
    );
    expect(nestedModuleRedeclaration.default).toBe("nested-var-module-ok");

    const loopExportsRedeclaration = await evaluateCommonJs(
      `for (var exports; false;) {} exports.value = "loop-var-exports-ok";`,
    );
    expect(loopExportsRedeclaration.value).toBe("loop-var-exports-ok");

    const blockRequireRedeclaration = await evaluateCommonJs(
      `{ var require; module.exports = require("node:path").sep; }`,
    );
    expect(blockRequireRedeclaration.default).toBe(path.sep);

    const selfRequireRedeclaration = await evaluateCommonJs(
      `var require = require; module.exports = require("node:path").sep;`,
    );
    expect(selfRequireRedeclaration.default).toBe(path.sep);

    const selfModuleRedeclaration = await evaluateCommonJs(
      `var module = module || { exports: {} }; module.exports = "self-module-ok";`,
    );
    expect(selfModuleRedeclaration.default).toBe("self-module-ok");

    const exportsAliasRedeclaration = await evaluateCommonJs(
      `var exports = module.exports; exports.value = "exports-alias-ok";`,
    );
    expect(exportsAliasRedeclaration.value).toBe("exports-alias-ok");

    const unreachableInitializer = await evaluateCommonJs(
      `if (false) { var module = {}; } module.exports = "unreachable-init-ok";`,
    );
    expect(unreachableInitializer.default).toBe("unreachable-init-ok");
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
    expect(
      transformCommonJs(`var require = (value) => value; require("local");`, "/app/value.js"),
    ).toBeNull();
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

  it("does not capture free references with generated helper bindings", async () => {
    Object.assign(globalThis, { __vinext_cjs_import__: "global" });
    try {
      const result = transformCommonJs(
        `export const value = __vinext_cjs_import__; require("node:path");`,
        "/app/value.js",
      );
      if (!result) throw new Error("Expected transformed code");
      expect(result.code).toContain('import * as __vinext_cjs_import___1 from "node:path";');
      const url = `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`;
      const module = await import(url);
      expect(module.value).toBe("global");
    } finally {
      delete (globalThis as Record<string, unknown>).__vinext_cjs_import__;
    }
  });

  it("avoids generated bindings shadowed in descendant scopes", async () => {
    const root = await mkdtemp(path.join(import.meta.dirname, ".tmp-commonjs-descendant-scope-"));
    await mkdir(path.join(root, "locales"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "static.js"), `export default "static";\n`),
      writeFile(path.join(root, "locales/en.js"), `export default "dynamic";\n`),
      writeFile(
        path.join(root, "entry.js"),
        `export function loadStatic() {
  const __vinext_cjs_import__ = { default: "shadowed-static" };
  return require("./static.js");
}
export function loadDynamic() {
  const __vinext_dynamic_require__ = () => ({ default: "shadowed-dynamic" });
  const locale = "en";
  return require(\`./locales/${"${locale}"}.js\`).default;
}
`,
      ),
    ]);
    const server = await createServer({
      root,
      logLevel: "silent",
      plugins: [createCommonJsPlugin()],
      server: { middlewareMode: true },
    });
    try {
      const module = await server.ssrLoadModule("/entry.js");
      expect(module.loadStatic()).toBe("static");
      expect(module.loadDynamic()).toBe("dynamic");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
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

  it("rejects require calls without a statically known path segment", async () => {
    for (const source of [
      `require(name);`,
      `require();`,
      `require(0);`,
      `require(name + "./messages/en.js");`,
      "require(`${name}/messages/en.js`);",
      `require(\`./messages/*/${"${name}"}.js\`);`,
    ]) {
      await expect(runPluginTransform(source, "/app/page.js")).rejects.toThrow(
        /cannot be statically analyzed/,
      );
      expect(() => transformCommonJs(source, "/app/page.js")).toThrow(
        /cannot be statically analyzed/,
      );
    }
  });

  it("rejects patterned requires for missing bare packages", async () => {
    await expect(
      runPluginTransform("require(`vinext-definitely-missing/${name}.js`);", "/app/page.js"),
    ).rejects.toThrow(/package .* could not be resolved/);
  });

  it("preserves explicitly ignored unsupported require expressions", async () => {
    const source = `require(/* webpackIgnore: true */ name);`;
    await expect(runPluginTransform(source, "/app/page.js")).resolves.toBeNull();
    expect(transformCommonJs(source, "/app/page.js")).toBeNull();
  });

  it("expands patterned dynamic requires with Node's glob implementation", async () => {
    const importer = path.join(
      import.meta.dirname,
      "fixtures/pages-basic/pages/cjs/dynamic-require.tsx",
    );
    const result = await runPluginTransform(
      `const messages = require(\`../../locales/${'${require("../../locale-name.js")}'}.js\`, sideEffect());`,
      importer,
    );
    if (!result || typeof result === "string" || !("code" in result)) {
      throw new Error("Expected transformed code");
    }
    const transformed = String(result.code);
    expect(transformed).toContain('from "../../locale-name.js"');
    expect(transformed).toContain('from "../../locales/en.js"');
    expect(transformed).toContain('from "../../locales/ru.js"');
    expect(transformed).toContain('case "../../locales/ru.js"');
    // vite-plugin-commonjs rewrites only the dynamic callee, preserving evaluation of extra args:
    // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/src/index.ts#L217-L220
    expect(transformed).toContain(
      "__vinext_dynamic_require__(`../../locales/${(__vinext_cjs_import__.default || __vinext_cjs_import__)}.js`, sideEffect())",
    );
    // vite-plugin-commonjs returns the imported namespace so callers can use `.default`:
    // https://github.com/vite-plugin/vite-plugin-commonjs/blob/v0.10.4/test/fixtures/src/dynamic.tsx
    const ruCase = transformed.match(/case "\.\.\/\.\.\/locales\/ru\.js": return ([^;]+);/)?.[1];
    expect(ruCase).toMatch(/^__vinext_cjs_import__/);
    expect(ruCase).not.toContain(".default");
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
    expect(transformed).toContain(JSON.stringify(toSlash(path.join(replacement, "ru.js"))));
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
    expect(transformed).toContain(JSON.stringify(toSlash(path.join(replacement, "ru.js"))));
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
        writeFile(path.join(root, "views/nested/component.js"), 'module.exports = "component";\n'),
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

      const staticSuffixResult = await runPluginTransform(
        `const view = require(\`./views/${"${name}"}/component\`);`,
        path.join(root, "page.js"),
      );
      if (
        !staticSuffixResult ||
        typeof staticSuffixResult === "string" ||
        !("code" in staticSuffixResult)
      ) {
        throw new Error("Expected transformed code");
      }
      const staticSuffix = String(staticSuffixResult.code);
      expect(staticSuffix).toContain('from "./views/nested/component.js"');
      expect(staticSuffix).toContain('case "./views/nested/component"');
      expect(staticSuffix).toContain('case "./views/nested/component.js"');

      await mkdir(path.join(root, "views/one/component"), { recursive: true });
      await writeFile(
        path.join(root, "views/one/component/index.js"),
        'export default "suffix-index";\n',
      );
      await writeFile(
        path.join(root, "suffix-index.js"),
        'const name = "one"; export default require(`./views/${name}/component`).default;\n',
      );
      const server = await createServer({
        root,
        logLevel: "silent",
        plugins: [createCommonJsPlugin()],
        server: { middlewareMode: true },
      });
      try {
        const module = await server.ssrLoadModule("/suffix-index.js");
        expect(module.default).toBe("suffix-index");
      } finally {
        await server.close();
      }
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
        JSON.stringify(toSlash(path.join(await realpath(packageDirectory), "ru.js"))),
      );
      expect(transformed).toContain('case "messages/ru.js"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // vite-plugin-dynamic-import keeps patterned bare-package imports on the nearest
  // node_modules path so Vite's preserveSymlinks setting remains authoritative:
  // https://github.com/vite-plugin/vite-plugin-dynamic-import/blob/v1.6.0/src/resolve.ts#L97-L128
  it("honors preserveSymlinks for patterned bare-package requires", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-symlink-pattern-"));
    try {
      const packageDirectory = path.join(root, "store/messages");
      const linkedPackageDirectory = path.join(root, "node_modules/messages");
      await Promise.all([
        mkdir(packageDirectory, { recursive: true }),
        mkdir(path.dirname(linkedPackageDirectory), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(packageDirectory, "package.json"), '{"name":"messages"}\n'),
        writeFile(path.join(packageDirectory, "ru.js"), "module.exports = import.meta.url;\n"),
        writeFile(
          path.join(root, "page.js"),
          `const locale = "ru"; export default require(\`messages/${"${locale}"}.js\`).default;\n`,
        ),
      ]);
      await symlink(
        packageDirectory,
        linkedPackageDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );

      const importer = path.join(root, "page.js");
      const source = `const messages = require(\`messages/${"${locale}"}.js\`);`;
      const preserved = await runPluginTransform(source, importer, [], true);
      const resolved = await runPluginTransform(source, importer);
      if (
        !preserved ||
        typeof preserved === "string" ||
        !("code" in preserved) ||
        !resolved ||
        typeof resolved === "string" ||
        !("code" in resolved)
      ) {
        throw new Error("Expected transformed code");
      }
      expect(String(preserved.code)).toContain(
        JSON.stringify(toSlash(path.join(linkedPackageDirectory, "ru.js"))),
      );
      expect(String(resolved.code)).toContain(
        JSON.stringify(toSlash(await realpath(path.join(packageDirectory, "ru.js")))),
      );

      const server = await createServer({
        root,
        logLevel: "silent",
        resolve: { preserveSymlinks: true },
        plugins: [createCommonJsPlugin()],
        server: { middlewareMode: true },
      });
      try {
        const module = await server.ssrLoadModule(toSlash(path.join(root, "page.js")));
        expect(module.default).toContain("/node_modules/messages/ru.js");
        expect(module.default).not.toContain("/store/messages/ru.js");
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // vite-plugin-dynamic-import v1.6.0 used fast-glob's default symlink traversal:
  // https://github.com/vite-plugin/vite-plugin-dynamic-import/blob/v1.6.0/src/index.ts
  it("follows symlinked directories matched by patterned requires", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-symlink-directory-"));
    try {
      const realTheme = path.join(root, "real-theme");
      const linkedTheme = path.join(root, "themes/linked");
      await Promise.all([
        mkdir(path.join(realTheme, "nested"), { recursive: true }),
        mkdir(path.dirname(linkedTheme), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(realTheme, "nested/value.js"), 'export default "symlink-ok";\n'),
        writeFile(
          path.join(root, "entry.js"),
          'const theme = "linked"; export default require(`./themes/${theme}/nested/value.js`).default;\n',
        ),
      ]);
      await symlink(realTheme, linkedTheme, process.platform === "win32" ? "junction" : "dir");

      const server = await createServer({
        root,
        logLevel: "silent",
        plugins: [createCommonJsPlugin()],
        server: { middlewareMode: true },
      });
      try {
        const module = await server.ssrLoadModule("/entry.js");
        expect(module.default).toBe("symlink-ok");
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches explicitly patterned dotfiles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-dotfile-pattern-"));
    try {
      await mkdir(path.join(root, "locales"), { recursive: true });
      await Promise.all([
        writeFile(path.join(root, "locales/.en.js"), 'export default "dotfile-ok";\n'),
        writeFile(
          path.join(root, "entry.js"),
          'const locale = "en"; export default require("./locales/." + locale + ".js").default;\n',
        ),
      ]);
      const server = await createServer({
        root,
        logLevel: "silent",
        plugins: [createCommonJsPlugin()],
        server: { middlewareMode: true },
      });
      try {
        const module = await server.ssrLoadModule("/entry.js");
        expect(module.default).toBe("dotfile-ok");
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enumerates candidates selected by static extglob syntax", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-extglob-pattern-"));
    try {
      await Promise.all([
        mkdir(path.join(root, "views/foo"), { recursive: true }),
        mkdir(path.join(root, "views/bar"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(root, "views/foo/en.js"), 'export default "foo";\n'),
        writeFile(path.join(root, "views/bar/en.js"), 'export default "bar";\n'),
      ]);
      const result = await runPluginTransform(
        'const name = "en"; require(`./views/+(foo|bar)/${name}.js`);',
        path.join(root, "entry.js"),
      );
      if (!result || typeof result === "string" || !("code" in result)) {
        throw new Error("Expected transformed code");
      }
      expect(String(result.code)).toContain('from "./views/foo/en.js"');
      expect(String(result.code)).toContain('from "./views/bar/en.js"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Ported from vite-plugin-dynamic-import v1.6.0's absolute-looking alias fixture:
  // https://github.com/vite-plugin/vite-plugin-dynamic-import/blob/v1.6.0/test/fixtures/src/main.ts
  it("resolves aliases before treating patterns as absolute filesystem paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-absolute-alias-"));
    try {
      const sourceRoot = path.join(root, "src");
      await mkdir(path.join(sourceRoot, "views"), { recursive: true });
      await Promise.all([
        writeFile(path.join(sourceRoot, "views/value.js"), 'export default "absolute-alias";\n'),
        writeFile(
          path.join(root, "entry.js"),
          'const id = "value"; export default require(`/root/src/views/${id}.js`).default; export const relative = require(`./views/${id}.js`).default;\n',
        ),
      ]);
      const server = await createServer({
        root,
        logLevel: "silent",
        resolve: {
          alias: [
            { find: "/root/src", replacement: sourceRoot },
            { find: ".", replacement: sourceRoot },
          ],
        },
        plugins: [createCommonJsPlugin()],
        server: { middlewareMode: true },
      });
      try {
        const module = await server.ssrLoadModule("/entry.js");
        expect(module.default).toBe("absolute-alias");
        expect(module.relative).toBe("absolute-alias");
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves eager dynamic-before-static import evaluation order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-import-order-"));
    const orderKey = "__vinext_commonjs_import_order__";
    try {
      await mkdir(path.join(root, "dynamic"), { recursive: true });
      await mkdir(path.join(root, "dynamic/a"), { recursive: true });
      await Promise.all([
        writeFile(
          path.join(root, "static.js"),
          `globalThis.${orderKey}.push("static"); export default "static";\n`,
        ),
        ...["B", "a", "z", "á"].map((name) =>
          writeFile(
            path.join(root, `dynamic/${name}.js`),
            `globalThis.${orderKey}.push(${JSON.stringify(name)}); export default ${JSON.stringify(name)};\n`,
          ),
        ),
        writeFile(
          path.join(root, "dynamic/a/nested.js"),
          `globalThis.${orderKey}.push("nested"); export default "nested";\n`,
        ),
        writeFile(
          path.join(root, "entry.js"),
          'require("./dynamic/z.js"); require("./static.js"); const name = "a"; require(`./dynamic/${name}.js`); export default true;\n',
        ),
      ]);
      Object.assign(globalThis, { [orderKey]: [] });
      const server = await createServer({
        root,
        logLevel: "silent",
        plugins: [createCommonJsPlugin()],
        server: { middlewareMode: true },
      });
      try {
        await server.ssrLoadModule("/entry.js");
        expect((globalThis as Record<string, unknown>)[orderKey]).toEqual([
          "B",
          "a",
          "z",
          "á",
          "nested",
          "static",
        ]);
      } finally {
        await server.close();
      }
    } finally {
      delete (globalThis as Record<string, unknown>)[orderKey];
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

  it("expands patterns whose scoped package name is dynamic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-commonjs-dynamic-package-"));
    try {
      const packageDirectory = path.join(root, "node_modules/@scope/pkg-a");
      await mkdir(packageDirectory, { recursive: true });
      await Promise.all([
        writeFile(path.join(packageDirectory, "file.js"), 'export default "scoped-package";\n'),
        writeFile(
          path.join(root, "entry.js"),
          'const variant = "a"; export default require(`@scope/pkg-${variant}/file.js`).default;\n',
        ),
      ]);
      const server = await createServer({
        root,
        logLevel: "silent",
        plugins: [createCommonJsPlugin()],
        server: { middlewareMode: true },
      });
      try {
        const module = await server.ssrLoadModule("/entry.js");
        expect(module.default).toBe("scoped-package");
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("preserves Windows drive traversal roots", () => {
    expect(globTraversalRoot("C:/*.js")).toBe("C:/");
  });
});
