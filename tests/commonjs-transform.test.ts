import { describe, expect, it } from "vite-plus/test";
import { transformCommonJs } from "../packages/vinext/src/plugins/commonjs.js";

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
});
