import { describe, expect, it } from "vite-plus/test";
import {
  getIsolatedRouteRuntime,
  replaceNextRuntimeForIsolatedRoute,
  withIsolatedRouteRuntime,
} from "../packages/vinext/src/plugins/route-runtime-isolation.js";
import { createDynamicPreloadMetadataPlugin } from "../packages/vinext/src/plugins/dynamic-preload-metadata.js";
import {
  createGoogleFontsPlugin,
  createLocalFontsPlugin,
} from "../packages/vinext/src/plugins/fonts.js";
import { createOptimizeImportsPlugin } from "../packages/vinext/src/plugins/optimize-imports.js";
import type { Plugin } from "vite";
import vinext from "../packages/vinext/src/index.js";

function transformIdInclude(plugin: Plugin): RegExp {
  const transform = plugin.transform as
    | { filter?: { id?: RegExp | { include?: RegExp } } }
    | undefined;
  const idFilter = transform?.filter?.id;
  const include = idFilter instanceof RegExp ? idFilter : idFilter?.include;
  if (!(include instanceof RegExp)) {
    throw new Error(`${plugin.name} must expose a RegExp transform id include filter`);
  }
  return include;
}

describe("route runtime isolation", () => {
  it("keeps query-qualified edge modules eligible for sibling RSC transforms", () => {
    const reactCanaryPlugin = (vinext() as Plugin[]).find(
      (plugin) => plugin.name === "vinext:react-canary",
    );
    if (!reactCanaryPlugin) throw new Error("vinext:react-canary plugin not found");
    const plugins = [
      createOptimizeImportsPlugin(
        () => undefined,
        () => "/project",
      ),
      createDynamicPreloadMetadataPlugin(),
      createGoogleFontsPlugin("/vinext/shims/font-google.ts", "/vinext/shims/"),
      createLocalFontsPlugin("/vinext/shims/"),
      reactCanaryPlugin,
    ];

    for (const plugin of plugins) {
      const include = transformIdInclude(plugin);
      expect(include.test("/project/app/page.tsx?vinext-route-runtime=edge")).toBe(true);
      expect(include.test("/project/app/helper.ts#fragment")).toBe(true);
      expect(include.test("/project/app/styles.css?vinext-route-runtime=edge")).toBe(false);
    }
  });

  it("preserves existing module queries while adding edge runtime identity", () => {
    const id = withIsolatedRouteRuntime("/project/shared.ts?raw&encoded=%2Fvalue#fragment", "edge");

    expect(id).toBe("/project/shared.ts?raw&encoded=%2Fvalue&vinext-route-runtime=edge#fragment");
    expect(getIsolatedRouteRuntime(id)).toBe("edge");
    expect(getIsolatedRouteRuntime("/project/shared.ts?raw=true")).toBeNull();
  });

  it("replaces an existing runtime identity without normalizing other query flags", () => {
    expect(
      withIsolatedRouteRuntime(
        "/project/shared.ts?raw&vinext-route-runtime=nodejs&raw#fragment",
        "edge",
      ),
    ).toBe("/project/shared.ts?raw&raw&vinext-route-runtime=edge#fragment");
  });

  it("folds real NEXT_RUNTIME expressions without rewriting inert source text", () => {
    const source = `
const runtime = process.env.NEXT_RUNTIME;
const text = "process.env.NEXT_RUNTIME";
// process.env.NEXT_RUNTIME
export default <p>{runtime}</p>;
`;

    const result = replaceNextRuntimeForIsolatedRoute(source, "/project/page.tsx", "edge");

    expect(result?.code).toContain('const runtime = "edge";');
    expect(result?.code).toContain('const text = "process.env.NEXT_RUNTIME";');
    expect(result?.code).toContain("// process.env.NEXT_RUNTIME");
  });

  it("handles TypeScript wrappers around route-runtime reads", () => {
    const result = replaceNextRuntimeForIsolatedRoute(
      "export const runtime = process.env.NEXT_RUNTIME as string;",
      "/project/runtime.ts?vinext-route-runtime=edge",
      "edge",
    );

    expect(result?.code).toBe('export const runtime = "edge" as string;');
  });
});
