import { describe, expect, it } from "vite-plus/test";
import {
  createPagesReqRes,
  getPagesPreviewData,
} from "../packages/vinext/src/server/pages-node-compat.js";
import type { NextApiHandler, NextApiRequest, NextApiResponse, PreviewData } from "next";

declare module "next" {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface NextApiRequest {
    userId?: string;
  }
}

type NextApiRequestPreviewFields = Pick<NextApiRequest, "preview" | "draftMode" | "previewData">;

const emptyNextApiRequestPreviewFields: NextApiRequestPreviewFields = {};

const previewDataValues: PreviewData[] = ["preview", false, {}, undefined];

function exerciseNextApiRequestPreviewTypes(req: NextApiRequest): NextApiRequestPreviewFields {
  req.query.missing = undefined;
  req.cookies.missing = undefined;
  req.body = undefined;
  req.body = { nested: true };
  req.env.EXAMPLE = undefined;
  req.env.EXAMPLE = "value";
  void (req.env.EXAMPLE satisfies string | undefined);
  req.preview = false;
  req.preview = undefined;
  req.draftMode = false;
  req.draftMode = undefined;
  req.previewData = false;
  req.previewData = undefined;

  return {
    preview: req.preview,
    draftMode: req.draftMode,
    previewData: req.previewData,
  };
}

function exerciseNextApiResponsePreviewTypes(res: NextApiResponse): Promise<void> {
  const temporaryRedirectResponse: NextApiResponse = res.redirect("/next");
  const permanentRedirectResponse: NextApiResponse = res.redirect(308, "/next");
  res.setPreviewData({ draft: true }, { maxAge: 60, path: "/preview" });
  res.clearPreviewData({ path: "/preview" });
  res.setDraftMode({ enable: true });
  void temporaryRedirectResponse;
  void permanentRedirectResponse;
  return res.revalidate("/preview", { unstable_onlyGenerated: true });
}

const nextApiHandler: NextApiHandler<{ ok: boolean }> = (req, res) => {
  req.query.optional = undefined;
  req.cookies.optional = undefined;
  req.userId = "user-123";
  const userId: string | undefined = req.userId;
  res.status(200).json({ ok: true });
  void userId;
};

void exerciseNextApiResponsePreviewTypes;
void exerciseNextApiRequestPreviewTypes;
void emptyNextApiRequestPreviewFields;
void previewDataValues;
void nextApiHandler;

describe("Pages Node compat response", () => {
  it("does not expose process environment variables on the request", () => {
    const previousValue = process.env.VINEXT_API_REQUEST_ENV_TEST;
    process.env.VINEXT_API_REQUEST_ENV_TEST = "secret";

    try {
      const { req } = createPagesReqRes({
        body: undefined,
        query: {},
        request: new Request("https://example.test/api/env"),
        url: "/api/env",
      });

      expect(req).not.toHaveProperty("env");
    } finally {
      if (previousValue === undefined) {
        delete process.env.VINEXT_API_REQUEST_ENV_TEST;
      } else {
        process.env.VINEXT_API_REQUEST_ENV_TEST = previousValue;
      }
    }
  });

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

  it("accepts a bypass-only draft mode cookie with empty preview data", () => {
    const enabled = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/enable"),
      url: "/api/enable",
    });
    enabled.res.setDraftMode({ enable: true });
    const cookies = enabled.res.getHeader("Set-Cookie");
    if (!Array.isArray(cookies)) throw new Error("expected Set-Cookie array");
    expect(cookies).toHaveLength(1);
    const cookieHeader = cookies[0].split(";", 1)[0];

    const { req, res } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/read", {
        headers: { cookie: cookieHeader },
      }),
      url: "/api/read",
    });

    expect(req.preview).toBe(true);
    expect(req.draftMode).toBe(req.preview);
    expect(req.previewData).toEqual({});
    res.setDraftMode({ enable: false });
    expect(res.getHeader("Set-Cookie")).toEqual([
      expect.stringMatching(/^__prerender_bypass=; Expires=/),
    ]);
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

  it("exposes preview state on API requests and clears both cookies", async () => {
    const enabled = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/enable"),
      url: "/api/enable",
    });
    enabled.res.setPreviewData({ hello: "world" });
    const enabledCookies = enabled.res.getHeader("Set-Cookie");
    if (!Array.isArray(enabledCookies)) throw new Error("expected Set-Cookie array");
    const cookieHeader = enabledCookies.map((value) => value.split(";", 1)[0]).join("; ");

    const { req, res, responsePromise } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/read", {
        headers: { cookie: cookieHeader },
      }),
      url: "/api/read",
    });

    expect(req.preview).toBe(true);
    expect(req.draftMode).toBe(req.preview);
    expect(req.previewData).toEqual({ hello: "world" });
    res.clearPreviewData({ path: "/docs" }).end("ok");

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(
        /^__prerender_bypass=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=\/docs;/,
      ),
      expect.stringMatching(
        /^__next_preview_data=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=\/docs;/,
      ),
    ]);
  });

  it("clears preview cookies only once per response", () => {
    const { res } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/clear"),
      url: "/api/clear",
    });

    res.clearPreviewData();
    res.clearPreviewData({ path: "/docs" });

    expect(res.getHeader("Set-Cookie")).toEqual([
      expect.stringMatching(/^__prerender_bypass=; Expires=/),
      expect.stringMatching(/^__next_preview_data=; Expires=/),
    ]);
  });

  it("does not duplicate an automatic invalid-cookie clear", () => {
    const { req, res } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/clear", {
        headers: { cookie: "__prerender_bypass=invalid; __next_preview_data=invalid" },
      }),
      url: "/api/clear",
    });

    expect(req.preview).toBeUndefined();
    expect(req.draftMode).toBeUndefined();
    res.clearPreviewData({ path: "/docs" });

    expect(res.getHeader("Set-Cookie")).toEqual([
      expect.stringMatching(/^__prerender_bypass=; Expires=/),
      expect.stringMatching(/^__next_preview_data=; Expires=/),
    ]);
  });
});
