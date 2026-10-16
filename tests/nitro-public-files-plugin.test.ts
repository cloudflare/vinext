import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createNitroPublicFilesPlugin,
  NITRO_ASSETS_KEY,
  type NitroAssets,
} from "../packages/vinext/src/server/nitro-public-files-plugin.js";

describe("Nitro public files plugin", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, Symbol.for(NITRO_ASSETS_KEY));
    vi.restoreAllMocks();
  });

  it("fetches assets through the Nitro app with a marker only the plugin can set", async () => {
    const received: Request[] = [];
    const nitroApp = {
      fetch: (request: Request): Response | Promise<Response> => {
        received.push(request);
        return new Response("file");
      },
    };
    createNitroPublicFilesPlugin()(nitroApp);
    const assets = Reflect.get(globalThis, Symbol.for(NITRO_ASSETS_KEY)) as NitroAssets;

    const response = await assets.fetch(new Request("http://localhost/hello.txt"));

    expect(await response.text()).toBe("file");
    expect(received).toHaveLength(1);
    expect(new URL(received[0].url).pathname).toBe("/hello.txt");
    expect(assets.isAssetRequest(received[0])).toBe(true);
    const forged = new Request("http://localhost/hello.txt", {
      headers: { "x-vinext-nitro-asset": received[0].headers.get("x-vinext-nitro-asset")! + "x" },
    });
    expect(assets.isAssetRequest(forged)).toBe(false);
    expect(assets.isAssetRequest(new Request("http://localhost/hello.txt"))).toBe(false);
  });
});
