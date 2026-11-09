import { describe, expect, it } from "vite-plus/test";
import { collectClientBuildFiles } from "../packages/vinext/src/build/pages-client-assets-module.js";
import { resolveClientBuildFile } from "../packages/vinext/src/server/client-build-files.js";

describe("resolveClientBuildFile", () => {
  const files = new Set(["/remoteEntry.js", "/literal%2Fname.js"]);

  it("matches a percent-encoded basePath segment", () => {
    expect(resolveClientBuildFile("/docs%20caf%C3%A9/remoteEntry.js", "/docs café", files)).toBe(
      "/remoteEntry.js",
    );
    expect(resolveClientBuildFile("/docs/remoteEntry.js", "/docs café", files)).toBeNull();
  });

  it("keeps once- and twice-encoded delimiters distinct", () => {
    expect(resolveClientBuildFile("/literal%252Fname.js", "", files)).toBe("/literal%252Fname.js");
    expect(resolveClientBuildFile("/literal%2Fname.js", "", files)).toBeNull();
  });
});

describe("collectClientBuildFiles", () => {
  it("records emitted files outside _next/static, excluding build metadata", () => {
    expect(
      collectClientBuildFiles([
        "remoteEntry.js",
        ".assetsignore",
        ".vite/manifest.json",
        "_next/static/chunks/app.js",
      ]),
    ).toEqual(["/remoteEntry.js"]);
  });
});
