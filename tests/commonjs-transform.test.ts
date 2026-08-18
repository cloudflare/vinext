import { describe, expect, it } from "vite-plus/test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

  it("supports computed static export names but not invalid ESM names", () => {
    const result = transformCommonJs(
      `exports["valid"] = 1; exports["not-valid"] = 2;`,
      "/app/value.js",
    );
    expect(result?.code).toContain("__vinext_cjs_export_valid__ as valid");
    expect(result?.code).not.toContain("not-valid as");
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
        JSON.stringify(path.join(await realpath(packageDirectory), "ru.js")),
      );
      expect(transformed).toContain('case "messages/ru.js"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
