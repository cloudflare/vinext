import { describe, expect, it } from "vite-plus/test";
import { createPagesDevModuleUrl } from "../packages/vinext/src/server/pages-dev-module-url.js";

describe("createPagesDevModuleUrl", () => {
  it("uses Vite's configured base without applying assetPrefix", () => {
    expect(createPagesDevModuleUrl("/repo", "/repo/pages/about.tsx", "/docs/")).toBe(
      "/docs/pages/about.tsx",
    );
  });

  it("preserves root-base behavior", () => {
    expect(createPagesDevModuleUrl("/repo", "/repo/pages/about.tsx", "/")).toBe("/pages/about.tsx");
  });

  it("normalizes Windows paths", () => {
    expect(createPagesDevModuleUrl("C:\\repo", "C:\\repo\\pages\\about.tsx", "/docs/")).toBe(
      "/docs/pages/about.tsx",
    );
  });

  it("encodes path query and fragment delimiters", () => {
    expect(createPagesDevModuleUrl("/repo", "/repo/pages/what?#.tsx", "/docs/")).toBe(
      "/docs/pages/what%3F%23.tsx",
    );
  });

  it("preserves dynamic route brackets for Vite module resolution", () => {
    expect(createPagesDevModuleUrl("/repo", "/repo/pages/blog/[slug].tsx", "/docs/")).toBe(
      "/docs/pages/blog/[slug].tsx",
    );
  });

  it("returns a stable URL for Vite HMR module identity", () => {
    const first = createPagesDevModuleUrl("/repo", "/repo/pages/about.tsx", "/docs/");
    const second = createPagesDevModuleUrl("/repo", "/repo/pages/about.tsx", "/docs/");
    expect(second).toBe(first);
  });
});
