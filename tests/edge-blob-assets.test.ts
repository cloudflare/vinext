import { describe, expect, it } from "vite-plus/test";
import { transformEdgeBlobAssetUrls } from "../packages/vinext/src/plugins/edge-blob-assets.js";

describe("edge blob assets", () => {
  it("inlines local import.meta.url asset URLs as fetchable data URLs", async () => {
    // Ported from Next.js: test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
    const transformed = await transformEdgeBlobAssetUrls(
      `const url = new URL("../../src/text-file.txt", import.meta.url); return fetch(url);`,
      "/app/pages/api/edge.js",
      async () => Buffer.from("Hello, from text-file.txt!"),
    );

    expect(transformed).toContain('new URL("data:text/plain;base64,');
    expect(transformed).toContain(Buffer.from("Hello, from text-file.txt!").toString("base64"));
  });

  it("leaves remote URLs untouched", async () => {
    const source = `const url = new URL("https://example.vercel.sh"); return fetch(url);`;
    await expect(transformEdgeBlobAssetUrls(source, "/app/pages/api/edge.js")).resolves.toBeNull();
  });
});
