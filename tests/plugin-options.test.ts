import { describe, expect, it } from "vite-plus/test";
import {
  flattenPluginOptions,
  selectHybridPagesUserPlugins,
} from "../packages/vinext/src/utils/plugin-options.js";

describe("flattenPluginOptions", () => {
  it("resolves nested promised plugin composition in order", async () => {
    const first = { name: "first" };
    const second = { name: "second" };

    await expect(
      flattenPluginOptions([Promise.resolve([first, false]), [[Promise.resolve(second)]]]),
    ).resolves.toEqual([first, second]);
  });

  it("selects promised hybrid user plugins and excludes framework plugin families", async () => {
    const userPlugin = { name: "vite:svgr" };
    const selected = await selectHybridPagesUserPlugins([
      Promise.resolve(userPlugin),
      { name: "vinext:config" },
      { name: "vite:react-babel" },
      { name: "rsc:build" },
      { name: "vite-rsc-load-module-dev-proxy" },
      { name: "vite-plugin-cloudflare" },
      false,
    ]);

    expect(selected).toEqual([userPlugin]);
  });
});
