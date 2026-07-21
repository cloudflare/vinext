import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";

const appPageProbePath = new URL(
  "../packages/vinext/src/server/app-page-probe.ts",
  import.meta.url,
);

describe("app page probe cold runtime", () => {
  it("does not load the full use cache runtime for page props marking", async () => {
    const source = await readFile(appPageProbePath, "utf8");

    expect(source).toContain("vinext/shims/internal/app-page-props-cache-key");
    expect(source).not.toContain("vinext/shims/cache-runtime");
  });
});
