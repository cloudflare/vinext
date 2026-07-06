import { describe, expect, it } from "vite-plus/test";
import { flattenPluginOptions } from "../packages/vinext/src/utils/plugin-options.js";

describe("flattenPluginOptions", () => {
  it("resolves nested promised plugin composition in order", async () => {
    const first = { name: "first" };
    const second = { name: "second" };

    await expect(
      flattenPluginOptions([Promise.resolve([first, false]), [[Promise.resolve(second)]]]),
    ).resolves.toEqual([first, second]);
  });
});
