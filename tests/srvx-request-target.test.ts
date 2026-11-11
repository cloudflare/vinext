import { describe, expect, it } from "vite-plus/test";
import nitroRequestTargetPlugin from "../packages/vinext/src/server/nitro-request-target-plugin.js";
import { isSrvxAbsoluteFormTarget } from "../packages/vinext/src/server/srvx-request-target.js";

function srvxRequest(
  url: string,
  rawTarget: string,
): Request & { runtime: { node: { req: { url: string } } } } {
  return Object.assign(new Request(url), { runtime: { node: { req: { url: rawTarget } } } });
}

describe("isSrvxAbsoluteFormTarget", () => {
  it("ignores requests that srvx doesn't serve on Node", () => {
    expect(isSrvxAbsoluteFormTarget(new Request("https://other.example/x"))).toBe(false);
  });

  it("rejects a raw target that is not origin-form", () => {
    expect(isSrvxAbsoluteFormTarget(srvxRequest("http://shop.example/x", "/x"))).toBe(false);
    for (const target of ["https://other.example/x", "http://shop.example/x", "*"]) {
      const request = srvxRequest("http://other.example/x", target);
      expect(isSrvxAbsoluteFormTarget(request), target).toBe(true);
    }
  });

  // srvx 0.11 writes the pathname h3 decodes back into req.url.
  it("reads the target the Nitro plugin saved before h3 rewrote req.url", () => {
    const seen: Request[] = [];
    const nitroApp = {
      fetch: (request: Request) => {
        seen.push(request);
        (request as ReturnType<typeof srvxRequest>).runtime.node.req.url = "/a";
        return new Response();
      },
    };
    nitroRequestTargetPlugin(nitroApp);
    void nitroApp.fetch(srvxRequest("https://other.example/a", "https://other.example/%61"));
    void nitroApp.fetch(srvxRequest("http://shop.example/a", "/%61"));
    expect(seen.map(isSrvxAbsoluteFormTarget)).toEqual([true, false]);
  });
});
