import { describe, expect, it } from "vite-plus/test";
import {
  createPagesReqRes,
  getPagesPreviewData,
} from "../packages/vinext/src/server/pages-node-compat.js";

describe("Pages Node compat response", () => {
  it("setPreviewData appends both preview cookies while preserving existing cookies", () => {
    const { res } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/enable"),
      url: "/api/enable",
    });

    res.setHeader("Set-Cookie", "existing=1; Path=/");
    res.setPreviewData({ hello: "world" });

    const cookies = res.getHeader("Set-Cookie");
    if (!Array.isArray(cookies)) throw new Error("expected Set-Cookie array");
    expect(cookies).toHaveLength(3);
    expect(cookies).toEqual(
      expect.arrayContaining([
        "existing=1; Path=/",
        expect.stringMatching(/^__prerender_bypass=/),
        expect.stringMatching(/^__next_preview_data=/),
      ]),
    );
  });

  it("reads preview data from cookies emitted by setPreviewData", () => {
    const { res } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/enable"),
      url: "/api/enable",
    });

    res.setPreviewData({ hello: "world" });

    const cookies = res.getHeader("Set-Cookie");
    if (!Array.isArray(cookies)) throw new Error("expected Set-Cookie array");
    const cookieHeader = cookies.map((value) => value.split(";", 1)[0]).join("; ");

    const request = new Request("https://example.test/preview", {
      headers: { cookie: cookieHeader },
    });
    expect(getPagesPreviewData(request)).toEqual({ hello: "world" });
    expect(getPagesPreviewData(request, { isOnDemandRevalidate: true })).toBe(false);
  });

  it("rejects preview data when the bypass cookie secret is wrong", () => {
    const { res } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/enable"),
      url: "/api/enable",
    });

    res.setPreviewData({ hello: "world" });

    const cookies = res.getHeader("Set-Cookie");
    if (!Array.isArray(cookies)) throw new Error("expected Set-Cookie array");
    const cookieHeader = cookies
      .map((value) => value.split(";", 1)[0])
      .map((value) =>
        value.startsWith("__prerender_bypass=") ? "__prerender_bypass=wrong-secret" : value,
      )
      .join("; ");

    const request = new Request("https://example.test/preview", {
      headers: { cookie: cookieHeader },
    });
    expect(getPagesPreviewData(request)).toBe(false);
  });
});
