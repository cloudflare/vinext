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

  function setup() {
    const received: Request[] = [];
    const nitroApp = {
      fetch: (request: Request): Response | Promise<Response> => {
        received.push(request);
        return new Response("nitro");
      },
    };
    createNitroPublicFilesPlugin({
      publicAssets: [
        "/index.html",
        "/hello.txt",
        "/hello.txt.gz",
        "/a b.txt",
        "/a#b.txt",
        "/a\\b.txt",
        "/docs/index.html",
        // Files that `public/` holds only compressed.
        "/data.json.gz",
        "/app/index.html.br",
      ],
      fetchApp: async () => new Response("vinext"),
    })(nitroApp);
    const assets = Reflect.get(globalThis, Symbol.for(NITRO_ASSETS_KEY)) as NitroAssets;
    const fetch = async (path: string, method = "GET", acceptEncoding?: string) => {
      const headers = acceptEncoding ? { "accept-encoding": acceptEncoding } : undefined;
      return (
        await nitroApp.fetch(new Request(`http://localhost${path}`, { method, headers }))
      ).text();
    };
    return { assets, fetch, received };
  }

  it("fetches assets through the Nitro app with a marker only the plugin can set", async () => {
    const { assets, received } = setup();

    // The asset fetch goes to the Nitro app as it was before the plugin
    // replaced its fetch, so it reaches the static handler.
    const response = await assets.fetch(new Request("http://localhost/hello.txt"));

    expect(await response.text()).toBe("nitro");
    expect(received).toHaveLength(1);
    expect(new URL(received[0].url).pathname).toBe("/hello.txt");
    expect(assets.isAssetRequest(received[0])).toBe(true);
    const forged = new Request("http://localhost/hello.txt", {
      headers: { "x-vinext-nitro-asset": received[0].headers.get("x-vinext-nitro-asset")! + "x" },
    });
    expect(assets.isAssetRequest(forged)).toBe(false);
    expect(assets.isAssetRequest(new Request("http://localhost/hello.txt"))).toBe(false);
  });

  it("answers 500 when vinext fails on a public file request", async () => {
    const captured: unknown[] = [];
    const error = new Error("render failed");
    const nitroApp = {
      fetch: (_request: Request): Response | Promise<Response> => new Response("nitro"),
      captureError: (cause: unknown) => captured.push(cause),
    };
    createNitroPublicFilesPlugin({
      publicAssets: ["/hello.txt"],
      fetchApp: () => {
        throw error;
      },
    })(nitroApp);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await nitroApp.fetch(new Request("http://localhost/hello.txt"));

    expect(response.status).toBe(500);
    expect(captured).toEqual([error]);
  });

  // Nitro's static handler answers these requests before any app handler, so
  // the plugin sends them to vinext instead.
  it.each([
    ["/hello.txt", "GET", ""],
    ["/hello.txt", "HEAD", ""],
    ["/hello.txt/", "GET", ""],
    ["/hello%2Etxt", "GET", ""],
    ["/a%20b.txt", "GET", ""],
    // h3 decodes these, and the URL parser resolves them to a public file.
    ["/hello.txt%5C", "GET", ""],
    ["/hello%09.txt", "GET", ""],
    ["/hello%0A.txt", "GET", ""],
    ["/x%5C..%5Chello.txt", "GET", ""],
    ["/x/.%09./hello.txt", "GET", ""],
    // Newer h3 releases leave decoding to Nitro, which serves public/a\b.txt.
    ["/a%5Cb.txt", "GET", ""],
    // srvx keeps a literal `#` in the pathname it hands h3.
    ["/a#b.txt", "GET", ""],
    ["/a#b.txt?x=1", "GET", ""],
    ["/a#%62.txt", "GET", ""],
    ["/docs", "GET", ""],
    ["/docs/", "GET", ""],
    ["/", "GET", ""],
    ["/hello.txt.gz", "GET", ""],
    ["/data.json", "GET", "gzip, deflate"],
    ["/data.json", "GET", "GZIP;q=1.0"],
    // Newer Nitro reads only the first `q`, and only with no space before `=`.
    ["/data.json", "GET", "gzip;q =0"],
    ["/data.json", "GET", "gzip;q=1;q=0"],
    ["/app", "GET", "br"],
  ])("sends %s %s (accept-encoding: %j) to vinext", async (path, method, acceptEncoding) => {
    expect(await setup().fetch(path, method, acceptEncoding)).toBe("vinext");
  });

  it.each([
    ["/hello.txt", "POST", ""],
    ["/missing.txt", "GET", ""],
    ["/a%2520b.txt", "GET", ""],
    ["/docs%2Findex.html", "GET", ""],
    ["/docs%2findex.html", "GET", ""],
    ["/hello%E0.txt", "GET", ""],
    ["/a?x#b.txt", "GET", ""],
    // Nitro serves a compressed copy only for an encoding the request accepts,
    // and only when it wrote that copy.
    ["/data.json", "GET", ""],
    ["/app", "GET", "gzip"],
    ["/data.json", "GET", "gzip;q=0"],
    ["/data.json", "GET", "br, gzip; q=0.0"],
    ["/a%20b.txt.gz", "GET", ""],
  ])("leaves %s %s (accept-encoding: %j) to Nitro", async (path, method, acceptEncoding) => {
    expect(await setup().fetch(path, method, acceptEncoding)).toBe("nitro");
  });
});
