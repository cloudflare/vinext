import { describe, expect, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";

const appPageProbePath = new URL(
  "../packages/vinext/src/server/app-page-probe.ts",
  import.meta.url,
);

describe("app page probe cold runtime", () => {
  it("does not load the full use cache runtime", async () => {
    const source = await readFile(appPageProbePath, "utf8");

    expect(source).not.toContain("vinext/shims/cache-runtime");
  });
});
