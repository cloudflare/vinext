import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { ViteDevServer } from "vite";
import { describe, expect, it } from "vite-plus/test";
import {
  decodeVlqSegment,
  installDevStackSourcemapMiddleware,
  mapStackLine,
  mapStackLineWithMetadata,
  originalPositionFor,
  resolveSourceFile,
  VINEXT_ORIGINAL_STACK_TRACE_ENDPOINT,
  type SourceMapPayload,
} from "../packages/vinext/src/server/dev-stack-sourcemap.js";

const SOURCE_MAP = {
  sources: ["./original.tsx"],
  mappings: "AAAA,KASE",
} satisfies SourceMapPayload;

const SITE_FOOTER_SOURCE = [
  "line 1",
  "line 2",
  "line 3",
  "const before = true;",
  "export function SiteFooter() {",
  '  throw new Error("vinext is not ready yet. Stay tuned!");',
  "  return (",
  '    <footer className="mt-auto">',
  "      <div />",
  "    </footer>",
].join("\n");

type DevStackMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

function createServer(
  sourceMap: SourceMapPayload | null = SOURCE_MAP,
  options: { root?: string } = {},
): {
  server: ViteDevServer;
  transformRequests: string[];
  middlewareHandlers: DevStackMiddleware[];
} {
  const transformRequests: string[] = [];
  const middlewareHandlers: DevStackMiddleware[] = [];
  const server = {
    environments: {
      client: {
        async transformRequest(viteUrl: string) {
          transformRequests.push(`client:${viteUrl}`);
          return { map: sourceMap };
        },
      },
      rsc: {
        async transformRequest(viteUrl: string) {
          transformRequests.push(`rsc:${viteUrl}`);
          return { map: sourceMap };
        },
      },
    },
    config: {
      root: options.root ?? "/repo/app",
    },
    middlewares: {
      use(handler: DevStackMiddleware) {
        middlewareHandlers.push(handler);
      },
    },
  } as unknown as ViteDevServer;

  return { server, transformRequests, middlewareHandlers };
}

function mockStackTraceRequest(body: string): IncomingMessage {
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    method: "POST",
    url: VINEXT_ORIGINAL_STACK_TRACE_ENDPOINT,
    headers: { host: "localhost:5173" },
  }) as unknown as IncomingMessage;

  queueMicrotask(() => {
    stream.end(body);
  });

  return req;
}

function mockResponse(): ServerResponse & {
  _body: string;
  _headers: Record<string, string>;
  _statusCode: number;
  done: Promise<void>;
} {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const headers: Record<string, string> = {};
  let headersSent = false;
  const res = {
    statusCode: 200,
    get headersSent() {
      return headersSent;
    },
    _body: "",
    _headers: headers,
    _statusCode: 200,
    done,
    writeHead(status: number, hdrs?: Record<string, string>) {
      res.statusCode = status;
      res._statusCode = status;
      headersSent = true;
      if (hdrs) {
        for (const [key, value] of Object.entries(hdrs)) {
          headers[key.toLowerCase()] = value;
        }
      }
      return res;
    },
    end(data?: string | Buffer) {
      if (data !== undefined) {
        res._body = Buffer.isBuffer(data) ? data.toString("utf8") : data;
      }
      resolveDone();
      return res;
    },
  } as unknown as ServerResponse & {
    _body: string;
    _headers: Record<string, string>;
    _statusCode: number;
    done: Promise<void>;
  };

  return res;
}

describe("installDevStackSourcemapMiddleware", () => {
  it("returns 413 when the stack trace request body exceeds 1 MB", async () => {
    const { server, middlewareHandlers, transformRequests } = createServer();
    installDevStackSourcemapMiddleware(server);
    const middleware = middlewareHandlers[0];
    expect(middleware).toBeDefined();

    const req = mockStackTraceRequest(JSON.stringify({ stack: "x".repeat(1024 * 1024) }));
    const res = mockResponse();
    let nextCalled = false;

    middleware!(req, res, () => {
      nextCalled = true;
    });

    await res.done;

    expect(nextCalled).toBe(false);
    expect(res._statusCode).toBe(413);
    expect(JSON.parse(res._body)).toEqual({ error: "Payload Too Large" });
    expect(transformRequests).toEqual([]);
  });

  it("returns ignored frame metadata from the middleware response", async () => {
    const { server, middlewareHandlers } = createServer({
      sources: ["site-footer.tsx"],
      sourcesContent: [SITE_FOOTER_SOURCE],
      mappings: ";;;;;;;;AAKQ",
    });
    installDevStackSourcemapMiddleware(server);
    const middleware = middlewareHandlers[0];
    expect(middleware).toBeDefined();

    const req = mockStackTraceRequest(
      JSON.stringify({
        stack: [
          "Error: boom",
          "    at SiteFooter (/repo/app/app/_components/site-footer.tsx:9:8)",
          "    at render (/repo/app/node_modules/.vite/deps_ssr/react.js:1:2)",
        ].join("\n"),
      }),
    );
    const res = mockResponse();

    middleware!(req, res, () => {});
    await res.done;

    expect(res._statusCode).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      stack: [
        "Error: boom",
        "    at SiteFooter (file:///repo/app/app/_components/site-footer.tsx:6:9)",
        "    at render (/repo/app/node_modules/.vite/deps_ssr/react.js:1:2)",
      ].join("\n"),
      ignoredFrames: [false, true],
      projectRoot: "/repo/app",
      codeFrame: {
        file: "file:///repo/app/app/_components/site-footer.tsx",
        line: 6,
        column: 9,
        methodName: "SiteFooter",
        lines: [
          { line: 4, text: "const before = true;", isErrorLine: false },
          { line: 5, text: "export function SiteFooter() {", isErrorLine: false },
          {
            line: 6,
            text: '  throw new Error("vinext is not ready yet. Stay tuned!");',
            isErrorLine: true,
          },
          { line: 7, text: "  return (", isErrorLine: false },
          { line: 8, text: '    <footer className="mt-auto">', isErrorLine: false },
          { line: 9, text: "      <div />", isErrorLine: false },
        ],
      },
    });
  });

  it("keeps ignored frame metadata aligned with unknown stack lines rendered by the overlay", async () => {
    const { server, middlewareHandlers } = createServer({
      sources: ["site-footer.tsx"],
      sourcesContent: [SITE_FOOTER_SOURCE],
      mappings: ";;;;;;;;AAKQ",
    });
    installDevStackSourcemapMiddleware(server);
    const middleware = middlewareHandlers[0];
    expect(middleware).toBeDefined();

    const req = mockStackTraceRequest(
      JSON.stringify({
        stack: [
          "Error: boom",
          "    at SiteFooter (/repo/app/app/_components/site-footer.tsx:9:8)",
          "Caused by: Error: nested",
          "    at render (/repo/app/node_modules/.vite/deps_ssr/react.js:1:2)",
        ].join("\n"),
      }),
    );
    const res = mockResponse();

    middleware!(req, res, () => {});
    await res.done;

    expect(res._statusCode).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({
      stack: [
        "Error: boom",
        "    at SiteFooter (file:///repo/app/app/_components/site-footer.tsx:6:9)",
        "Caused by: Error: nested",
        "    at render (/repo/app/node_modules/.vite/deps_ssr/react.js:1:2)",
      ].join("\n"),
      ignoredFrames: [false, false, true],
    });
  });
});

describe("decodeVlqSegment", () => {
  it("decodes base64 VLQ source-map segments", () => {
    expect(decodeVlqSegment("AAAA")).toEqual([0, 0, 0, 0]);
    expect(decodeVlqSegment("KACE")).toEqual([5, 0, 1, 2]);
    expect(decodeVlqSegment("GACD")).toEqual([3, 0, 1, -1]);
  });

  it("returns an empty segment for invalid VLQ characters", () => {
    expect(decodeVlqSegment("$")).toEqual([]);
  });
});

describe("originalPositionFor", () => {
  it("uses the nearest mapped segment at or before the generated column", () => {
    const sourceMap = {
      sources: ["source.tsx"],
      mappings: "AAAA,KACE,GACD",
    } satisfies SourceMapPayload;

    expect(originalPositionFor(sourceMap, 1, 1)).toEqual({
      source: "source.tsx",
      line: 1,
      column: 1,
    });
    expect(originalPositionFor(sourceMap, 1, 7)).toEqual({
      source: "source.tsx",
      line: 2,
      column: 3,
    });
    expect(originalPositionFor(sourceMap, 1, 9)).toEqual({
      source: "source.tsx",
      line: 3,
      column: 2,
    });
  });

  it("treats single-field generated-only segments as unmapped ranges", () => {
    const sourceMap = {
      sources: ["source.tsx"],
      mappings: "AAAA,KACE,C,GACD",
    } satisfies SourceMapPayload;

    expect(originalPositionFor(sourceMap, 1, 7)).toBeNull();
    expect(originalPositionFor(sourceMap, 1, 10)).toEqual({
      source: "source.tsx",
      line: 3,
      column: 2,
    });
  });

  it("resets generated columns per line while carrying original fields across lines", () => {
    const sourceMap = {
      sources: ["source.tsx"],
      mappings: "AAAA,KACE;AACA",
    } satisfies SourceMapPayload;

    expect(originalPositionFor(sourceMap, 2, 1)).toEqual({
      source: "source.tsx",
      line: 3,
      column: 3,
    });
  });
});

describe("mapStackLine", () => {
  const cases = [
    {
      name: "V8 paren frames",
      input: "    at onClick (http://localhost:5173/src/App.tsx?t=1:1:6)",
      expected: "    at onClick (http://localhost:5173/src/original.tsx:10:3)",
    },
    {
      name: "V8 bare frames",
      input: "    at http://localhost:5173/src/App.tsx?t=1:1:6",
      expected: "    at http://localhost:5173/src/original.tsx:10:3",
    },
    {
      name: "Moz frames",
      input: "onClick@http://localhost:5173/src/App.tsx?t=1:1:6",
      expected: "onClick@http://localhost:5173/src/original.tsx:10:3",
    },
  ];

  for (const { name, input, expected } of cases) {
    it(`maps ${name}`, async () => {
      const { server, transformRequests } = createServer();

      await expect(
        mapStackLine(
          server,
          input,
          "localhost:5173",
          new Map<string, Promise<SourceMapPayload | null>>(),
        ),
      ).resolves.toBe(expected);
      expect(transformRequests).toEqual(["client:/src/App.tsx?t=1"]);
    });
  }

  it("leaves frames unchanged when the generated URL host does not match the request host", async () => {
    const { server, transformRequests } = createServer();
    const line = "    at onClick (http://evil.test/src/App.tsx?t=1:1:6)";

    await expect(
      mapStackLine(
        server,
        line,
        "localhost:5173",
        new Map<string, Promise<SourceMapPayload | null>>(),
      ),
    ).resolves.toBe(line);
    expect(transformRequests).toEqual([]);
  });

  it("reports ignore-list metadata for source-map ignored sources", async () => {
    const { server, transformRequests } = createServer({
      sources: ["./original.tsx"],
      mappings: "AAAA,KASE",
      ignoreList: [0],
    });
    const line = "    at onClick (http://localhost:5173/src/App.tsx?t=1:1:6)";

    await expect(
      mapStackLineWithMetadata(
        server,
        line,
        "localhost:5173",
        new Map<string, Promise<SourceMapPayload | null>>(),
      ),
    ).resolves.toEqual({
      line: "    at onClick (http://localhost:5173/src/original.tsx:10:3)",
      isFrame: true,
      ignored: true,
    });
    expect(transformRequests).toEqual(["client:/src/App.tsx?t=1"]);
  });

  it("reports ignore-list metadata for unmapped dependency frames", async () => {
    const { server, transformRequests } = createServer();
    const line = "    at render (/repo/app/node_modules/.vite/deps_ssr/react.js:1:2)";

    await expect(
      mapStackLineWithMetadata(
        server,
        line,
        undefined,
        new Map<string, Promise<SourceMapPayload | null>>(),
      ),
    ).resolves.toEqual({
      line,
      isFrame: true,
      ignored: true,
    });
    expect(transformRequests).toEqual([]);
  });

  it("reports ignore-list metadata for unmapped Windows dependency frames", async () => {
    const { server, transformRequests } = createServer(undefined, { root: "C:\\repo\\app" });
    const line = "    at render (C:\\repo\\app\\node_modules\\react\\index.js:1:2)";

    await expect(
      mapStackLineWithMetadata(
        server,
        line,
        undefined,
        new Map<string, Promise<SourceMapPayload | null>>(),
      ),
    ).resolves.toEqual({
      line,
      isFrame: true,
      ignored: true,
    });
    expect(transformRequests).toEqual([]);
  });

  it("does not ignore-list app frames by default", async () => {
    const { server, transformRequests } = createServer({
      sources: ["site-footer.tsx"],
      mappings: ";;;;;;;;AAKQ",
    });
    const line = "    at SiteFooter (/repo/app/app/_components/site-footer.tsx:9:8)";

    await expect(
      mapStackLineWithMetadata(
        server,
        line,
        undefined,
        new Map<string, Promise<SourceMapPayload | null>>(),
      ),
    ).resolves.toEqual({
      line: "    at SiteFooter (file:///repo/app/app/_components/site-footer.tsx:6:9)",
      isFrame: true,
      ignored: false,
    });
    expect(transformRequests).toEqual(["rsc:/repo/app/app/_components/site-footer.tsx"]);
  });

  it("returns a code frame for the mapped app frame when source content is available", async () => {
    const { server, transformRequests } = createServer({
      sources: ["site-footer.tsx"],
      sourcesContent: [SITE_FOOTER_SOURCE],
      mappings: ";;;;;;;;AAKQ",
    });
    const line = "    at SiteFooter (/repo/app/app/_components/site-footer.tsx:9:8)";

    await expect(
      mapStackLineWithMetadata(
        server,
        line,
        undefined,
        new Map<string, Promise<SourceMapPayload | null>>(),
      ),
    ).resolves.toEqual({
      line: "    at SiteFooter (file:///repo/app/app/_components/site-footer.tsx:6:9)",
      isFrame: true,
      ignored: false,
      codeFrame: {
        file: "file:///repo/app/app/_components/site-footer.tsx",
        line: 6,
        column: 9,
        methodName: "SiteFooter",
        lines: [
          { line: 4, text: "const before = true;", isErrorLine: false },
          { line: 5, text: "export function SiteFooter() {", isErrorLine: false },
          {
            line: 6,
            text: '  throw new Error("vinext is not ready yet. Stay tuned!");',
            isErrorLine: true,
          },
          { line: 7, text: "  return (", isErrorLine: false },
          { line: 8, text: '    <footer className="mt-auto">', isErrorLine: false },
          { line: 9, text: "      <div />", isErrorLine: false },
        ],
      },
    });
    expect(transformRequests).toEqual(["rsc:/repo/app/app/_components/site-footer.tsx"]);
  });

  it("maps local filesystem frames through the RSC environment source map", async () => {
    const { server, transformRequests } = createServer({
      sources: ["site-footer.tsx"],
      mappings: ";;;;;;;;AAKQ",
    });
    const line = "    at SiteFooter (/repo/app/app/_components/site-footer.tsx:9:8)";

    await expect(
      mapStackLine(server, line, undefined, new Map<string, Promise<SourceMapPayload | null>>()),
    ).resolves.toBe("    at SiteFooter (file:///repo/app/app/_components/site-footer.tsx:6:9)");
    expect(transformRequests).toEqual(["rsc:/repo/app/app/_components/site-footer.tsx"]);
  });

  it("recognizes Windows local filesystem frames under the project root", async () => {
    const { server, transformRequests } = createServer(null, { root: "C:\\repo\\app" });
    const line = "    at SiteFooter (C:\\repo\\app\\app\\_components\\site-footer.tsx:9:8)";

    await expect(
      mapStackLine(server, line, undefined, new Map<string, Promise<SourceMapPayload | null>>()),
    ).resolves.toBe(line);
    expect(transformRequests).toEqual(["rsc:C:\\repo\\app\\app\\_components\\site-footer.tsx"]);
  });

  it("leaves local filesystem frames unchanged when no server source map is available", async () => {
    const { server, transformRequests } = createServer(null);
    const line = "    at SiteFooter (/repo/app/app/_components/site-footer.tsx:9:8)";

    await expect(
      mapStackLine(server, line, undefined, new Map<string, Promise<SourceMapPayload | null>>()),
    ).resolves.toBe(line);
    expect(transformRequests).toEqual(["rsc:/repo/app/app/_components/site-footer.tsx"]);
  });

  it("maps React Server component frame URLs through the RSC environment source map", async () => {
    const { server, transformRequests } = createServer({
      sources: ["site-footer.tsx"],
      mappings: ";;;;;;;;AAKQ",
    });
    const line =
      "    at SiteFooter (about://React/Server/file:///repo/app/app/_components/site-footer.tsx?9:9:8)";

    await expect(
      mapStackLine(server, line, undefined, new Map<string, Promise<SourceMapPayload | null>>()),
    ).resolves.toBe("    at SiteFooter (file:///repo/app/app/_components/site-footer.tsx:6:9)");
    expect(transformRequests).toEqual(["rsc:/repo/app/app/_components/site-footer.tsx"]);
  });

  it("decodes file URLs before asking Vite for a server source map", async () => {
    const { server, transformRequests } = createServer({
      sources: ["site footer.tsx"],
      mappings: ";;;;;;;;AAKQ",
    });
    const line =
      "    at SiteFooter (about://React/Server/file:///repo/app/app/_components/site%20footer.tsx?9:9:8)";

    await expect(
      mapStackLine(server, line, undefined, new Map<string, Promise<SourceMapPayload | null>>()),
    ).resolves.toBe("    at SiteFooter (file:///repo/app/app/_components/site%20footer.tsx:6:9)");
    expect(transformRequests).toEqual(["rsc:/repo/app/app/_components/site footer.tsx"]);
  });
});

describe("resolveSourceFile", () => {
  it("resolves relative sources against the generated URL", () => {
    expect(
      resolveSourceFile(
        "./original.tsx",
        { sources: [], mappings: "AAAA" },
        new URL("http://localhost:5173/src/App.tsx?t=1"),
      ),
    ).toBe("http://localhost:5173/src/original.tsx");
  });

  it("resolves sourceRoot before source paths", () => {
    expect(
      resolveSourceFile(
        "src/page.tsx",
        { sources: [], sourceRoot: "file:///repo/app", mappings: "AAAA" },
        new URL("http://localhost:5173/generated/chunk.js"),
      ),
    ).toBe("file:///repo/app/src/page.tsx");
  });
});
