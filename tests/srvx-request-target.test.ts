import { describe, expect, it } from "vite-plus/test";
import { isSrvxAbsoluteFormTarget } from "../packages/vinext/src/server/srvx-request-target.js";

function srvxRequest(url: string, rawTarget: string, headers: Record<string, string>): Request {
  return Object.assign(new Request(url), {
    runtime: { node: { req: { url: rawTarget, headers } } },
  });
}

describe("isSrvxAbsoluteFormTarget", () => {
  it("ignores requests that srvx doesn't serve on Node", () => {
    expect(isSrvxAbsoluteFormTarget(new Request("https://other.example/x"))).toBe(false);
  });

  it("accepts an origin-form target", () => {
    const request = srvxRequest("http://shop.example/x", "/x", { host: "shop.example" });
    expect(isSrvxAbsoluteFormTarget(request)).toBe(false);
  });

  it("rejects an absolute-form target, even one naming the Host header", () => {
    for (const target of ["https://other.example/x", "http://shop.example/x"]) {
      const request = srvxRequest(target, target, { host: "shop.example" });
      expect(isSrvxAbsoluteFormTarget(request), target).toBe(true);
    }
  });

  // srvx 0.11 writes the pathname h3 decodes back into req.url.
  it("rejects an origin the headers don't name after req.url was rewritten", () => {
    for (const url of ["https://other.example/x", "ftp://shop.example/x"]) {
      const request = srvxRequest(url, "/x", { host: "shop.example" });
      expect(isSrvxAbsoluteFormTarget(request), url).toBe(true);
    }
  });

  it("accepts the origins srvx builds for an origin-form target", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["https://shop.example/x", { host: "Shop.Example:443" }],
      ["http://_invalid_/x", { host: "shop.example/x" }],
      ["http://127.0.0.1:3000/x", {}],
      ["http://127.0.0.1:3000/x", { host: "" }],
      // A trusted X-Forwarded-Host (srvx 0.12 and later).
      [
        "http://public.example/x",
        { host: "shop.example", "x-forwarded-host": "a, public.example" },
      ],
    ];
    for (const [url, headers] of cases) {
      expect(isSrvxAbsoluteFormTarget(srvxRequest(url, "/x", headers)), url).toBe(false);
    }
  });
});
