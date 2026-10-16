import { describe, expect, it } from "vite-plus/test";
import { once } from "node:events";
import {
  createPagesApiReqRes,
  createPagesReqRes,
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
  it.each([204, 205, 304])(
    "creates a bodyless %i response while preserving custom headers",
    async (status) => {
      // Ported from Next.js: test/e2e/api-support/pages/api/status-204.js
      // https://github.com/vercel/next.js/blob/canary/test/e2e/api-support/pages/api/status-204.js
      const { res, responsePromise } = createPagesReqRes({
        body: undefined,
        query: {},
        request: new Request("https://example.test/api/status-204"),
        url: "/api/status-204",
      });

      res.setHeader("Surrogate-Control", "max-age=14400");
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Length", "18");
      res.setHeader("Transfer-Encoding", "chunked");
      res.status(status);
      const finished = once(res, "finish");
      res.write("discard-one");
      res.write("discard-two");
      res.end("discard-three");

      const response = await responsePromise;
      expect(response.status).toBe(status);
      expect(response.headers.get("surrogate-control")).toBe("max-age=14400");
      expect(response.headers.get("content-type")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("transfer-encoding")).toBeNull();
      expect(response.body).toBeNull();
      await expect(response.text()).resolves.toBe("");
      await finished;
      expect((res as unknown as { bufferedChunks: Buffer[] }).bufferedChunks).toHaveLength(0);
    },
  );

  // Next.js only attaches res.revalidate() in apiResolver:
  // packages/next/src/server/api-utils/node/api-resolver.ts
  it("only exposes revalidate() on API route responses", () => {
    const request = new Request("https://example.test/page");
    const { res: pageRes } = createPagesReqRes({
      body: undefined,
      query: {},
      request,
      url: "/page",
    });
    const { res: apiRes } = createPagesApiReqRes({
      body: undefined,
      query: {},
      request,
      url: "/page",
    });

    expect(pageRes).not.toHaveProperty("revalidate");
    expect(typeof apiRes.revalidate).toBe("function");
  });

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

    const { req } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/preview", {
        headers: { cookie: cookieHeader },
      }),
      url: "/preview",
    });
    expect(req.previewData).toEqual({ hello: "world" });
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

    const { req } = createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/preview", {
        headers: { cookie: cookieHeader },
      }),
      url: "/preview",
    });
    expect(req.previewData).toBe(false);
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

describe("Pages Node compat appendHeader", () => {
  function createApiResponse() {
    return createPagesReqRes({
      body: undefined,
      query: {},
      request: new Request("https://example.test/api/append"),
      url: "/api/append",
    });
  }

  it("validates appended headers at the call site like Node", () => {
    const { res } = createApiResponse();

    expect(() => res.appendHeader("x-bad", "bad\nvalue")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_CHAR" }),
    );
    expect(() => res.appendHeader("bad name", "1")).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_HTTP_TOKEN" }),
    );
    expect(res.getHeader("x-bad")).toBeUndefined();
  });

  it("rejects appendHeader after writeHead like Node", () => {
    const { res } = createApiResponse();

    res.writeHead(200);
    expect(() => res.appendHeader("x-late", "1")).toThrow(
      expect.objectContaining({ code: "ERR_HTTP_HEADERS_SENT" }),
    );
  });

  it("treats Object.prototype names as ordinary headers", async () => {
    const { res, responsePromise } = createApiResponse();

    res.appendHeader("constructor", "route");
    res.appendHeader("__proto__", "route");
    res.end();

    const response = await responsePromise;
    expect(response.headers.get("constructor")).toBe("route");
    expect(response.headers.get("__proto__")).toBe("route");
  });

  it("keeps the caller's array like Node", async () => {
    const { res, responsePromise } = createApiResponse();

    const values = ["a"];
    res.appendHeader("x-list", values);
    values.push("b");
    res.appendHeader("x-list", "c");
    expect(res.getHeader("x-list")).toBe(values);

    res.end();
    const response = await responsePromise;
    expect(response.headers.get("x-list")).toBe("a, b, c");
  });

  it("stores Set-Cookie like any other header", async () => {
    const { res, responsePromise } = createApiResponse();

    res.appendHeader("Set-Cookie", "a=1; Path=/");
    expect(res.getHeader("Set-Cookie")).toBe("a=1; Path=/");
    const cookies = ["b=1; Path=/"];
    res.appendHeader("x-unrelated", "1");
    res.setHeader("Set-Cookie", cookies);
    cookies.push("c=1; Path=/");
    res.appendHeader("Set-Cookie", "d=1; Path=/");
    expect(res.getHeader("Set-Cookie")).toBe(cookies);

    res.end();
    const response = await responsePromise;
    expect(response.headers.getSetCookie()).toEqual(["b=1; Path=/", "c=1; Path=/", "d=1; Path=/"]);
  });

  it("keeps an existing scalar's type when appending to it", async () => {
    const { res, responsePromise } = createApiResponse();

    res.setHeader("x-count", 123);
    res.appendHeader("x-count", "later");
    expect(res.getHeader("x-count")).toEqual([123, "later"]);

    res.end();
    const response = await responsePromise;
    expect(response.headers.get("x-count")).toBe("123, later");
  });
});
