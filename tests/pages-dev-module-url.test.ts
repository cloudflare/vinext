import { describe, expect, it } from "vite-plus/test";
import path from "node:path";
import {
  createPagesDevAssetUrl,
  createPagesDevModuleUrl,
} from "../packages/vinext/src/server/pages-dev-module-url.js";

describe("createPagesDevModuleUrl", () => {
  it("uses Vite's configured base without applying assetPrefix", () => {
    expect(createPagesDevModuleUrl("/repo", "/repo/pages/about.tsx", "/docs/")).toBe(
      "/docs/pages/about.tsx",
    );
  });

  it("preserves root-base behavior", () => {
    expect(createPagesDevModuleUrl("/repo", "/repo/pages/about.tsx", "/")).toBe("/pages/about.tsx");
  });

  it("prefixes virtual development assets with Vite's configured base", () => {
    expect(createPagesDevAssetUrl("/@id/__x00__virtual:vinext-client-entry", "/docs/")).toBe(
      "/docs/@id/__x00__virtual:vinext-client-entry",
    );
  });

  it("uses Vite's filesystem URL for modules outside the app root", () => {
    expect(
      createPagesDevModuleUrl(
        "/repo/examples/app",
        "/repo/packages/vinext/src/client/dev-error-overlay.tsx",
        "/docs/",
      ),
    ).toBe("/docs/@fs//repo/packages/vinext/src/client/dev-error-overlay.tsx");
  });

  it.runIf(process.platform === "win32")(
    "uses Vite's filesystem URL for modules on another Windows drive",
    () => {
      const appRoot = path.resolve("D:\\repo\\app");
      const modulePath = path.resolve("C:\\repo\\vinext\\dev-error-overlay.tsx");
      expect(createPagesDevModuleUrl(appRoot, modulePath, "/docs/")).toBe(
        "/docs/@fs/C:/repo/vinext/dev-error-overlay.tsx",
      );
    },
  );

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
