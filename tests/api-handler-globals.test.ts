import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PassThrough } from "node:stream";
import type http from "node:http";
import type { Route } from "../packages/vinext/src/routing/pages-router.js";
import type { ModuleImporter } from "../packages/vinext/src/server/instrumentation.js";

vi.mock("../packages/vinext/src/server/instrumentation.js", () => ({
  reportRequestError: vi.fn(() => Promise.resolve()),
  importModule: (runner: { import(id: string): Promise<unknown> }, id: string) =>
    runner.import(id) as Promise<Record<string, unknown>>,
}));

type GlobalWithAsyncLocalStorage = typeof globalThis & {
  AsyncLocalStorage?: new <Store>() => {
    getStore(): Store | undefined;
    run<T>(store: Store, callback: () => T): T;
  };
};

type MockResponse = http.ServerResponse & {
  _body: string | Buffer;
  _headers: Record<string, string | string[]>;
  _statusCode: number;
  _writes: Buffer[];
};

const originalAsyncLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "AsyncLocalStorage");

afterEach(() => {
  if (originalAsyncLocalStorage) {
    Object.defineProperty(globalThis, "AsyncLocalStorage", originalAsyncLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "AsyncLocalStorage");
  }
});

function route(pattern: string, filePath = "/fake/api/handler.ts"): Route {
  const isDynamic = pattern.includes(":");
  const params = isDynamic ? [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]) : [];
  return { pattern, patternParts: pattern.split("/").filter(Boolean), filePath, isDynamic, params };
}

function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    method,
    url,
    headers,
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: false,
    connection: null,
    socket: null,
    aborted: false,
    rawHeaders: [] as string[],
    trailers: {} as Record<string, string | undefined>,
    rawTrailers: [] as string[],
    statusCode: undefined,
    statusMessage: undefined,
  }) as unknown as http.IncomingMessage;

  queueMicrotask(() => stream.push(null));
  return req;
}

function mockRes(): MockResponse {
  const headers: Record<string, string | string[]> = {};
  const res = {
    statusCode: 200,
    _body: "",
    _headers: headers,
    _statusCode: 200,
    _writes: [] as Buffer[],
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value;
    },
    write(data: string | Buffer | Uint8Array) {
      const chunk =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
      res._writes.push(chunk);
      res._body = Buffer.isBuffer(res._body)
        ? Buffer.concat([res._body, chunk])
        : res._body
          ? Buffer.concat([Buffer.from(res._body), chunk])
          : chunk;
      return true;
    },
    end(data?: string | Buffer) {
      if (data !== undefined) {
        if (res._writes.length) {
          res.write(data);
        } else {
          res._body = data;
        }
      }
      res._statusCode = res.statusCode;
    },
    destroy() {
      return res;
    },
  } as unknown as MockResponse;
  return res;
}

describe("handleApiRoute edge runtime globals", () => {
  it("installs global AsyncLocalStorage before importing edge API modules", async () => {
    Reflect.deleteProperty(globalThis, "AsyncLocalStorage");

    vi.resetModules();
    const { handleApiRoute } = await import("../packages/vinext/src/server/api-handler.js");
    const server: ModuleImporter = {
      import: vi.fn().mockImplementation(async () => {
        const AsyncLocalStorage = (globalThis as GlobalWithAsyncLocalStorage).AsyncLocalStorage;
        if (typeof AsyncLocalStorage !== "function") {
          throw new Error("AsyncLocalStorage global missing during user module import");
        }

        const storage = new AsyncLocalStorage<{ id: string }>();
        return {
          config: { runtime: "edge" },
          default: (request: Request) => {
            const id = request.headers.get("req-id") ?? "";
            return storage.run({ id }, () => Response.json(storage.getStore()));
          },
        };
      }),
    };
    const req = mockReq("GET", "/api/users", {
      host: "example.com",
      "req-id": "req-42",
    });
    const res = mockRes();

    await handleApiRoute(server, req, res, "/api/users", [route("/api/users")]);

    expect(res._statusCode).toBe(200);
    expect(res._body.toString()).toBe(JSON.stringify({ id: "req-42" }));
  });
});
