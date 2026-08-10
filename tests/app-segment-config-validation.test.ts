import { describe, expect, it } from "vite-plus/test";
import { validateAppSegmentConfigSource } from "../packages/vinext/src/plugins/app-segment-config-validation.js";

describe("validateAppSegmentConfigSource", () => {
  const options = {
    cacheComponents: true,
    isClientModule: false,
    route: "/instant/page",
  };

  it("validates direct, aliased, and locally indirect instant exports", () => {
    expect(() =>
      validateAppSegmentConfigSource(
        `const samples = [{}]
         const instant = { prefetch: "runtime", samples }
         export { instant as unstable_instant }`,
        options,
      ),
    ).not.toThrow();

    expect(() =>
      validateAppSegmentConfigSource(
        `const samples = []
         const instant = { prefetch: "runtime", samples }
         export { instant as unstable_instant }`,
        options,
      ),
    ).toThrow(/Invalid unstable_instant value/);
  });

  it("rejects instant exports from client modules before runtime", () => {
    expect(() =>
      validateAppSegmentConfigSource("export const unstable_instant = false", {
        ...options,
        isClientModule: true,
      }),
    ).toThrow(/Client Component module/);
  });

  it("rejects instant exports without Cache Components, including false", () => {
    expect(() =>
      validateAppSegmentConfigSource("export const unstable_instant = false", {
        ...options,
        cacheComponents: false,
      }),
    ).toThrow(/without enabling `cacheComponents`/);
  });

  it("rejects instant together with dynamic stale time", () => {
    expect(() =>
      validateAppSegmentConfigSource(
        `export const unstable_instant = { prefetch: "static" }
         export const unstable_dynamicStaleTime = 30`,
        options,
      ),
    ).toThrow(/cannot use both/);
  });

  it("defers cross-file re-export values to runtime validation", () => {
    expect(() =>
      validateAppSegmentConfigSource(`export { unstable_instant } from "./config"`, options),
    ).not.toThrow();
  });
});
