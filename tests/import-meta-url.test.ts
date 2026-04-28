import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { transformNextImportMetaUrl } from "../packages/vinext/src/plugins/import-meta-url.js";

describe("import.meta.url transform", () => {
  it("rewrites server import.meta.url to the source file URL", () => {
    // Ported from Next.js: test/e2e/import-meta/import-meta.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/import-meta/import-meta.test.ts
    const root = "/repo/app";
    const id = path.join(root, "pages/index.tsx");
    const result = transformNextImportMetaUrl("export const url = import.meta.url;", id, {
      environmentName: "ssr",
      root,
    });

    expect(result?.code).toContain(JSON.stringify(pathToFileURL(id).href));
  });

  it("rewrites client import.meta.url with the Turbopack ROOT placeholder", () => {
    // Ported from Next.js: test/e2e/import-meta/import-meta.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/import-meta/import-meta.test.ts
    const root = "/repo/app";
    const id = path.join(root, "pages/index.tsx");
    const result = transformNextImportMetaUrl("export const url = import.meta.url;", id, {
      environmentName: "client",
      root,
      turbopackRootPlaceholder: true,
    });

    expect(result?.code).toContain('"file:///ROOT/pages/index.tsx"');
  });

  it("does not rewrite import.meta.url used as a new URL asset base", () => {
    const root = "/repo/app";
    const code = 'export const asset = new URL("./asset.txt", import.meta.url);';
    const result = transformNextImportMetaUrl(code, path.join(root, "pages/index.tsx"), {
      environmentName: "client",
      root,
      turbopackRootPlaceholder: true,
    });

    expect(result).toBeNull();
  });
});
