import { describe, expect, it, vi } from "vite-plus/test";
import {
  handlePagesApiRoute,
  type PagesApiRouteMatch,
} from "../packages/vinext/src/server/pages-api-route.js";

function createMatch(
  handler: PagesApiRouteMatch["route"]["module"]["default"],
  params: Record<string, string | string[]> = {},
): PagesApiRouteMatch {
  return {
    params,
    route: {
      pattern: "/api/test",
      module: {
        default: handler,
      },
    },
  };
}

describe("pages api route", () => {
  it("merges dynamic params with duplicate query-string values", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch(
        (req, res) => {
          res.json(req.query);
        },
        { id: "123" },
      ),
      request: new Request("https://example.com/api/users/123?tag=a&tag=b"),
      url: "/api/users/123?tag=a&tag=b",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "123",
      tag: ["a", "b"],
    });
  });

  it("returns 400 with an Invalid JSON statusText for malformed JSON bodies", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((req, res) => {
        res.json(req.body ?? null);
      }),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"message":Invalid"}',
      }),
      url: "/api/parse",
    });

    expect(response.status).toBe(400);
    expect(response.statusText).toBe("Invalid JSON");
    await expect(response.text()).resolves.toBe("Invalid JSON");
  });

  it("preserves duplicate urlencoded keys and parses empty JSON bodies as {}", async () => {
    const parseHandler = (req: { body: unknown }, res: { json: (data: unknown) => void }) => {
      res.json(req.body ?? null);
    };

    const urlencodedResponse = await handlePagesApiRoute({
      match: createMatch(parseHandler),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "tag=a&tag=b&tag=c",
      }),
      url: "/api/parse",
    });
    await expect(urlencodedResponse.json()).resolves.toEqual({ tag: ["a", "b", "c"] });

    const emptyJsonResponse = await handlePagesApiRoute({
      match: createMatch(parseHandler),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "",
      }),
      url: "/api/parse",
    });
    await expect(emptyJsonResponse.json()).resolves.toEqual({});
  });

  it("sends Buffer payloads with octet-stream content-type and content-length", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.send(Buffer.from([1, 2, 3]));
      }),
      request: new Request("https://example.com/api/send-buffer"),
      url: "/api/send-buffer",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe("3");
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("reports thrown handler errors and returns a 500 response", async () => {
    const reportRequestError = vi.fn();

    const response = await handlePagesApiRoute({
      match: createMatch(() => {
        throw new Error("boom");
      }),
      reportRequestError,
      request: new Request("https://example.com/api/fail"),
      url: "/api/fail",
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("Internal Server Error");
    expect(reportRequestError).toHaveBeenCalledWith(expect.any(Error), "/api/test");
  });

  it("returns 413 when the API body exceeds the default size limit", async () => {
    const response = await handlePagesApiRoute({
      match: createMatch((_req, res) => {
        res.status(200).json({ ok: true });
      }),
      request: new Request("https://example.com/api/parse", {
        method: "POST",
        headers: {
          "content-length": String(2 * 1024 * 1024),
          "content-type": "application/json",
        },
        body: "{}",
      }),
      url: "/api/parse",
    });

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toBe("Request body too large");
  });
});
