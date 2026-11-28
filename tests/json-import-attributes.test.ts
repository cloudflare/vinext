import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build, createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import {
  collectJsonAttributeImports,
  createJsonImportAttributesPlugin,
} from "../packages/vinext/src/plugins/json-import-attributes.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function specifiers(code: string, id = "/app/page.ts"): string[] {
  return collectJsonAttributeImports(code, id).map((source) => source.value);
}

describe("collectJsonAttributeImports", () => {
  it("finds static imports and re-exports carrying a JSON type attribute", () => {
    expect(
      specifiers(
        [
          `import data from "../data" with { type: "json" };`,
          `export { default as other } from "./other" with { type: "json" };`,
          `export * from "./all" with { type: 'json' };`,
        ].join("\n"),
      ),
    ).toEqual(["../data", "./other", "./all"]);
  });

  it("finds dynamic imports with a JSON type attribute", () => {
    expect(specifiers(`const data = await import("./data", { with: { type: "json" } });`)).toEqual([
      "./data",
    ]);
  });

  it("leaves specifiers Vite already loads as JSON, and non-JSON attributes, alone", () => {
    expect(
      specifiers(
        [
          `import a from "./a.json" with { type: "json" };`,
          `import b from "./b.json5" with { type: "json" };`,
          `import c from "./c" with { type: "css" };`,
          `import d from "./d";`,
          `const e = await import("./e");`,
          `const f = await import(name, { with: { type: "json" } });`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("vinext:json-import-attributes", () => {
  it("rewrites the specifier so Vite's JSON plugin loads the file", async () => {
    const plugin = createJsonImportAttributesPlugin();
    const transform = plugin.transform as { handler: Function };
    const result = await transform.handler.call(
      {},
      `import data from "../data" with { type: "json" };\nexport default data.foo;\n`,
      "/app/pages/es.js",
    );
    expect(result.code).toContain(`from "../data?lang.json" with { type: "json" }`);
  });

  it("builds an extensionless JSON file imported with a JSON type attribute", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vinext-json-import-attributes-"));
    tempDirs.push(root);
    writeFileSync(path.join(root, "data"), `{\n  "foo": "foo-from-json"\n}\n`);
    writeFileSync(
      path.join(root, "entry.js"),
      `import data from "./data" with { type: "json" };\nexport const value = data.foo;\n`,
    );

    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [createJsonImportAttributesPlugin()],
      build: {
        outDir: "out",
        lib: { entry: path.join(root, "entry.js"), formats: ["es"], fileName: "entry" },
      },
    });

    const outDir = path.join(root, "out");
    const output = readdirSync(outDir)
      .map((file) => readFileSync(path.join(outDir, file), "utf8"))
      .join("\n");
    expect(output).toContain("foo-from-json");
  });
});
describe("vinext build with JSON import attributes (Next.js import-attributes parity)", () => {
  it("builds a page importing an extensionless JSON file with a JSON type attribute", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vinext-json-attributes-app-"));
    tempDirs.push(root);
    symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "json-attributes-fixture", private: true, type: "module" }),
    );
    writeFileSync(path.join(root, "data"), `{\n  "foo": "foo-from-extensionless-json"\n}\n`);
    mkdirSync(path.join(root, "pages"));
    writeFileSync(
      path.join(root, "pages", "index.tsx"),
      `import data from "../data" with { type: "json" };\n\nexport default function Page() {\n  return <p>{data.foo}</p>;\n}\n`,
    );

    const builder = await createBuilder({
      root,
      configFile: false,
      plugins: [vinext({ appDir: root })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const outDir = path.join(root, "dist");
    const output = readdirSync(outDir, { recursive: true })
      .map(String)
      .filter((file) => /\.m?js$/.test(file))
      .map((file) => readFileSync(path.join(outDir, file), "utf8"))
      .join("\n");
    expect(output).toContain("foo-from-extensionless-json");
  }, 120_000);
});
