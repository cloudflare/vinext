import { describe, expect, it } from "vite-plus/test";
import {
  getIsolatedRouteRuntime,
  replaceNextRuntimeForIsolatedRoute,
  withIsolatedRouteRuntime,
} from "../packages/vinext/src/plugins/route-runtime-isolation.js";

describe("route runtime isolation", () => {
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
