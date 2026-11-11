import { describe, expect, it } from "vite-plus/test";
import { rewriteOutputRootExternals } from "../packages/vinext/src/build/output-root-externals.js";

const targets = new Map([
  ["virtual:vinext-cacheability-manifest", "__vinext_cacheability_manifest.js"],
  ["virtual:vinext-pregenerated-concrete-paths", "__vinext_pregenerated_concrete_paths.js"],
]);

describe("rewriteOutputRootExternals", () => {
  it("points root chunk imports at sibling files", () => {
    const result = rewriteOutputRootExternals(
      'import m from "virtual:vinext-cacheability-manifest";\nimport "virtual:vinext-pregenerated-concrete-paths";\n',
      "index.js",
      targets,
    );
    expect(result?.code).toBe(
      'import m from "./__vinext_cacheability_manifest.js";\nimport "./__vinext_pregenerated_concrete_paths.js";\n',
    );
  });

  it("points nested chunk imports back to the output root", () => {
    // Rolldown can turn index.js into a facade and move the RSC entry into a
    // shared chunk such as _next/static/worker-entry-[hash].js.
    const result = rewriteOutputRootExternals(
      "import m from 'virtual:vinext-cacheability-manifest';",
      "_next/static/worker-entry-abc123.js",
      targets,
    );
    expect(result?.code).toBe("import m from '../../__vinext_cacheability_manifest.js';");
    expect(result?.map.mappings).not.toBe("");
  });

  it("resolves targets outside the output root", () => {
    const result = rewriteOutputRootExternals(
      'import a from "virtual:vinext-pages-client-assets";',
      "chunks/page.js",
      new Map([["virtual:vinext-pages-client-assets", "../vinext-client-assets.js"]]),
    );
    expect(result?.code).toBe('import a from "../../vinext-client-assets.js";');
  });

  it("leaves chunks without the externals untouched", () => {
    expect(
      rewriteOutputRootExternals(
        'const id = "\\0virtual:vinext-cacheability-manifest-other";',
        "index.js",
        targets,
      ),
    ).toBeNull();
    expect(rewriteOutputRootExternals("export {};", "index.js", targets)).toBeNull();
  });
});
