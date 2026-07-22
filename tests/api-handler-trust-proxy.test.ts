/**
 * Regression tests for F-PROD-7: the dev edge API bridge
 * (`createEdgeApiRequest` in `api-handler.ts`) was reading
 * `X-Forwarded-Proto` without the `trustProxy` gate that the rest of the
 * prod server uses. A client could forge `X-Forwarded-Proto: https` and
 * trick edge handlers that gate Secure-cookie issuance on
 * `request.url.startsWith("https")` into believing the request was
 * TLS-terminated.
 *
 * These tests verify:
 *   1. Without `VINEXT_TRUST_PROXY` / `VINEXT_TRUSTED_HOSTS`, the
 *      `X-Forwarded-Proto` / `X-Forwarded-Host` headers are ignored —
 *      `request.url` reflects the raw `Host` header and `http://`.
 *   2. With `VINEXT_TRUST_PROXY=1`, `X-Forwarded-Proto: https` is
 *      honored.
 *   3. With `VINEXT_TRUSTED_HOSTS` set, a matching `X-Forwarded-Host`
 *      is honored.
 *   4. With `VINEXT_TRUSTED_HOSTS` set, a non-matching
 *      `X-Forwarded-Host` is rejected and falls back to `Host`.
 *
 * Modules are dynamically re-imported per test so the trust policy
 * (read at module load time, mirroring prod-server) is recomputed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PassThrough } from "node:stream";
import http from "node:http";
import type { Route } from "../packages/vinext/src/routing/pages-router.js";

vi.mock("../packages/vinext/src/server/instrumentation.js", () => ({
  reportRequestError: vi.fn(() => Promise.resolve()),
  importModule: (runner: { import(id: string): Promise<unknown> }, id: string) =>
    runner.import(id) as Promise<Record<string, any>>,
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): http.IncomingMessage {
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    method,
    url,
    headers: { ...headers },
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

function mockRes(): http.ServerResponse & { _body: string | Buffer; _ended: boolean } {
  const headers: Record<string, string | string[]> = {};
  const res = {
    statusCode: 200,
    _body: "" as string | Buffer,
    _ended: false,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    writeHead(status: number) {
      res.statusCode = status;
    },
    write(data: string | Buffer | Uint8Array) {
      const chunk =
        typeof data === "string"
          ? Buffer.from(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
      res._body = Buffer.isBuffer(res._body)
        ? Buffer.concat([res._body, chunk])
        : res._body
          ? Buffer.concat([Buffer.from(res._body as string), chunk])
          : chunk;
      return true;
    },
    end(data?: string | Buffer) {
      if (data !== undefined) {
        if (res._body) {
          (res as any).write(data);
        } else {
          res._body = data;
        }
      }
      res._ended = true;
    },
  } as unknown as http.ServerResponse & { _body: string | Buffer; _ended: boolean };
  return res;
}

function route(pattern: string, filePath = "/fake/api/handler.ts"): Route {
  return {
    pattern,
    patternParts: pattern.split("/").filter(Boolean),
    filePath,
    isDynamic: false,
    params: [],
  };
}

async function captureEdgeRequestUrl(
  reqHeaders: Record<string, string>,
  reqUrl = "/api/users",
): Promise<string> {
  const { handleApiRoute } = await import("../packages/vinext/src/server/api-handler.js");
  let capturedUrl = "";
  const handler = vi.fn((request: Request) => {
    capturedUrl = request.url;
    return Response.json({ ok: true });
  });
  const server = {
    import: vi.fn().mockResolvedValue({
      config: { runtime: "edge" },
      default: handler,
    }),
  };
  const req = mockReq("GET", reqUrl, reqHeaders);
  const res = mockRes();
  await handleApiRoute(server, req, res, reqUrl, [route("/api/users")]);
  return capturedUrl;
}

describe("createEdgeApiRequest trust-proxy gating (F-PROD-7)", () => {
  describe("default (untrusted proxy)", () => {
    it("ignores X-Forwarded-Proto: https when VINEXT_TRUST_PROXY is unset", async () => {
      // Env vars left untouched — `VINEXT_TRUST_PROXY` and
      // `VINEXT_TRUSTED_HOSTS` are not present in the test environment.
      const url = await captureEdgeRequestUrl({
        host: "example.com",
        "x-forwarded-proto": "https",
      });
      expect(new URL(url).protocol).toBe("http:");
      expect(url).toBe("http://example.com/api/users");
    });

    it("ignores X-Forwarded-Host when no trusted hosts are configured", async () => {
      const url = await captureEdgeRequestUrl({
        host: "legit.example.com",
        "x-forwarded-host": "attacker.com",
      });
      expect(new URL(url).host).toBe("legit.example.com");
    });
  });

  describe("VINEXT_TRUST_PROXY=1", () => {
    it("honors X-Forwarded-Proto: https", async () => {
      vi.stubEnv("VINEXT_TRUST_PROXY", "1");
      const url = await captureEdgeRequestUrl({
        host: "example.com",
        "x-forwarded-proto": "https",
      });
      expect(new URL(url).protocol).toBe("https:");
      expect(url).toBe("https://example.com/api/users");
    });

    it("uses the first comma-separated X-Forwarded-Proto value", async () => {
      vi.stubEnv("VINEXT_TRUST_PROXY", "1");
      const url = await captureEdgeRequestUrl({
        host: "example.com",
        "x-forwarded-proto": "https, http",
      });
      expect(url).toBe("https://example.com/api/users");
    });

    it("falls back to http for unsupported X-Forwarded-Proto values", async () => {
      vi.stubEnv("VINEXT_TRUST_PROXY", "1");
      const url = await captureEdgeRequestUrl({
        host: "example.com",
        "x-forwarded-proto": "ftp",
      });
      expect(url).toBe("http://example.com/api/users");
    });

    it("does NOT honor X-Forwarded-Host when only VINEXT_TRUST_PROXY is set", async () => {
      // `VINEXT_TRUST_PROXY=1` alone gates the proto, not the host —
      // host poisoning still requires the explicit `VINEXT_TRUSTED_HOSTS`
      // allow-list, matching prod-server.ts behavior.
      vi.stubEnv("VINEXT_TRUST_PROXY", "1");
      const url = await captureEdgeRequestUrl({
        host: "legit.example.com",
        "x-forwarded-host": "attacker.com",
      });
      expect(new URL(url).host).toBe("legit.example.com");
    });
  });

  describe("VINEXT_TRUSTED_HOSTS allow-list", () => {
    it("honors X-Forwarded-Host when it matches the allow-list", async () => {
      vi.stubEnv("VINEXT_TRUSTED_HOSTS", "cdn.example.com");
      const url = await captureEdgeRequestUrl({
        host: "origin.internal",
        "x-forwarded-host": "cdn.example.com",
      });
      expect(new URL(url).host).toBe("cdn.example.com");
    });

    it("ignores X-Forwarded-Host when it does not match the allow-list", async () => {
      vi.stubEnv("VINEXT_TRUSTED_HOSTS", "cdn.example.com");
      const url = await captureEdgeRequestUrl({
        host: "origin.internal",
        "x-forwarded-host": "attacker.com",
      });
      expect(new URL(url).host).toBe("origin.internal");
    });

    it("implicitly enables trustProxy and honors X-Forwarded-Proto", async () => {
      // Per prod-server.ts: having a trusted-hosts allow-list implies a
      // trusted proxy, so X-Forwarded-Proto becomes honored.
      vi.stubEnv("VINEXT_TRUSTED_HOSTS", "cdn.example.com");
      const url = await captureEdgeRequestUrl({
        host: "origin.internal",
        "x-forwarded-host": "cdn.example.com",
        "x-forwarded-proto": "https",
      });
      expect(url).toBe("https://cdn.example.com/api/users");
    });

    it("matches X-Forwarded-Host case-insensitively", async () => {
      vi.stubEnv("VINEXT_TRUSTED_HOSTS", "cdn.example.com");
      const url = await captureEdgeRequestUrl({
        host: "origin.internal",
        "x-forwarded-host": "CDN.Example.COM",
      });
      expect(new URL(url).host).toBe("cdn.example.com");
    });

    it("uses the first comma-separated X-Forwarded-Host value", async () => {
      vi.stubEnv("VINEXT_TRUSTED_HOSTS", "cdn.example.com");
      const url = await captureEdgeRequestUrl({
        host: "origin.internal",
        "x-forwarded-host": "cdn.example.com, edge.cf",
      });
      expect(new URL(url).host).toBe("cdn.example.com");
    });
  });
});
