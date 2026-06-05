import type { ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

export const VINEXT_ORIGINAL_STACK_TRACE_ENDPOINT = "/__vinext_original-stack-trace";

const MAX_ORIGINAL_STACK_TRACE_BODY_BYTES = 1024 * 1024;

export type SourceMapPayload = {
  version?: number;
  sources: string[];
  sourceRoot?: string;
  mappings: string;
};

type SourceMapPosition = {
  source: string;
  line: number;
  column: number;
};

const V8_PAREN_STACK_LINE = /^(\s*at\s+.*?\()(.+):(\d+):(\d+)(\)\s*)$/;
const V8_BARE_STACK_LINE = /^(\s*at\s+)(.+):(\d+):(\d+)(\s*)$/;
const MOZ_STACK_LINE = /^([^@\n]*@)(.+):(\d+):(\d+)(\s*)$/;

class RequestBodyTooLargeError extends Error {}

const BASE64_VLQ_VALUES: Record<string, number> = Object.create(null) as Record<string, number>;
"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  .split("")
  .forEach((char, index) => {
    BASE64_VLQ_VALUES[char] = index;
  });

export function installDevStackSourcemapMiddleware(server: ViteDevServer): void {
  server.middlewares.use((req, res, next) => {
    if (!isOriginalStackTraceRequest(req)) {
      next();
      return;
    }

    handleOriginalStackTraceRequest(server, req, res).catch(() => {
      if (!res.headersSent) writeJson(res, 500, { error: "Internal Server Error" });
    });
  });
}

function isOriginalStackTraceRequest(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://vinext.local");
  return url.pathname === VINEXT_ORIGINAL_STACK_TRACE_ENDPOINT;
}

async function handleOriginalStackTraceRequest(
  server: ViteDevServer,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  try {
    const payload = parseStackTraceRequestBody(await readRequestBody(req));
    if (!payload) {
      writeJson(res, 400, { error: "Bad Request" });
      return;
    }

    const stack = await resolveDevServerStackTrace(
      server,
      payload.stack,
      getDevStackSourcemapRequestHost(req.headers),
    );
    writeJson(res, 200, { stack });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      writeJson(res, 413, { error: "Payload Too Large" });
      return;
    }
    writeJson(res, 500, { error: "Internal Server Error" });
  }
}

function parseStackTraceRequestBody(body: string): { stack: string } | null {
  try {
    const payload = JSON.parse(body) as { stack?: unknown };
    return typeof payload.stack === "string" ? { stack: payload.stack } : null;
  } catch {
    return null;
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_ORIGINAL_STACK_TRACE_BODY_BYTES) {
        settled = true;
        reject(new RequestBodyTooLargeError());
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(body);
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function getDevStackSourcemapRequestHost(headers: IncomingMessage["headers"]): string | undefined {
  return normalizeRequestHost(headers["x-forwarded-host"]) ?? normalizeRequestHost(headers.host);
}

function normalizeRequestHost(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim().toLowerCase() || undefined;
}

async function resolveDevServerStackTrace(
  server: ViteDevServer,
  stack: string,
  requestHost: string | undefined,
): Promise<string> {
  const sourceMapCache = new Map<string, Promise<SourceMapPayload | null>>();
  const mapped = await Promise.all(
    stack.split("\n").map((line) => mapStackLine(server, line, requestHost, sourceMapCache)),
  );
  return mapped.join("\n");
}

export async function mapStackLine(
  server: ViteDevServer,
  line: string,
  requestHost: string | undefined,
  sourceMapCache: Map<string, Promise<SourceMapPayload | null>>,
): Promise<string> {
  const v8Paren = line.match(V8_PAREN_STACK_LINE);
  if (v8Paren) {
    const mapped = await mapGeneratedFrame(
      server,
      v8Paren[2],
      v8Paren[3],
      v8Paren[4],
      requestHost,
      sourceMapCache,
    );
    return mapped
      ? `${v8Paren[1]}${mapped.file}:${mapped.line}:${mapped.column}${v8Paren[5]}`
      : line;
  }

  const v8Bare = line.match(V8_BARE_STACK_LINE);
  if (v8Bare) {
    const mapped = await mapGeneratedFrame(
      server,
      v8Bare[2],
      v8Bare[3],
      v8Bare[4],
      requestHost,
      sourceMapCache,
    );
    return mapped ? `${v8Bare[1]}${mapped.file}:${mapped.line}:${mapped.column}${v8Bare[5]}` : line;
  }

  const moz = line.match(MOZ_STACK_LINE);
  if (moz) {
    const mapped = await mapGeneratedFrame(
      server,
      moz[2],
      moz[3],
      moz[4],
      requestHost,
      sourceMapCache,
    );
    return mapped ? `${moz[1]}${mapped.file}:${mapped.line}:${mapped.column}${moz[5]}` : line;
  }

  return line;
}

async function mapGeneratedFrame(
  server: ViteDevServer,
  file: string,
  line: string,
  column: string,
  requestHost: string | undefined,
  sourceMapCache: Map<string, Promise<SourceMapPayload | null>>,
): Promise<{ file: string; line: number; column: number } | null> {
  const generatedUrl = getMappableGeneratedUrl(file, requestHost);
  if (!generatedUrl) return null;

  const generatedLine = Number(line);
  const generatedColumn = Number(column);
  if (!Number.isFinite(generatedLine) || !Number.isFinite(generatedColumn)) return null;

  const sourceMap = await getSourceMapForGeneratedUrl(server, generatedUrl, sourceMapCache);
  if (!sourceMap) return null;

  const original = originalPositionFor(sourceMap, generatedLine, generatedColumn);
  if (!original) return null;

  const originalFile = resolveSourceFile(original.source, sourceMap, generatedUrl);
  return {
    file: originalFile,
    line: original.line,
    column: original.column,
  };
}

function getMappableGeneratedUrl(file: string, requestHost: string | undefined): URL | null {
  const isAbsoluteHttpUrl = /^https?:\/\//i.test(file);
  let url: URL;
  try {
    url = new URL(file, "http://vinext.local");
  } catch {
    return null;
  }

  if (isAbsoluteHttpUrl && requestHost && url.host !== requestHost) {
    return null;
  }
  if (url.pathname.includes("/node_modules/")) return null;
  return url;
}

async function getSourceMapForGeneratedUrl(
  server: ViteDevServer,
  generatedUrl: URL,
  cache: Map<string, Promise<SourceMapPayload | null>>,
): Promise<SourceMapPayload | null> {
  const cacheKey = generatedUrl.pathname + generatedUrl.search;
  let sourceMap = cache.get(cacheKey);
  if (!sourceMap) {
    sourceMap = loadSourceMapForGeneratedUrl(server, generatedUrl);
    cache.set(cacheKey, sourceMap);
  }
  return sourceMap;
}

async function loadSourceMapForGeneratedUrl(
  server: ViteDevServer,
  generatedUrl: URL,
): Promise<SourceMapPayload | null> {
  try {
    const viteUrl = generatedUrl.pathname + generatedUrl.search;
    const result = await server.environments.client.transformRequest(viteUrl);
    return normalizeSourceMapPayload(result?.map);
  } catch {
    return null;
  }
}

function normalizeSourceMapPayload(payload: unknown): SourceMapPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const map = payload as {
    version?: unknown;
    sources?: unknown;
    sourceRoot?: unknown;
    mappings?: unknown;
  };
  if (!Array.isArray(map.sources) || typeof map.mappings !== "string" || map.mappings === "") {
    return null;
  }
  if (!map.sources.every((source): source is string => typeof source === "string")) return null;
  return {
    version: typeof map.version === "number" ? map.version : undefined,
    sources: map.sources,
    sourceRoot: typeof map.sourceRoot === "string" ? map.sourceRoot : undefined,
    mappings: map.mappings,
  };
}

export function originalPositionFor(
  sourceMap: SourceMapPayload,
  generatedLine: number,
  generatedColumn: number,
): SourceMapPosition | null {
  const targetLineIndex = generatedLine - 1;
  const targetColumn = Math.max(0, generatedColumn - 1);
  if (targetLineIndex < 0) return null;

  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  const generatedLines = sourceMap.mappings.split(";");

  for (let generatedLineIndex = 0; generatedLineIndex <= targetLineIndex; generatedLineIndex++) {
    const generatedSegments = generatedLines[generatedLineIndex];
    if (generatedSegments === undefined) return null;

    let generatedSegmentColumn = 0;
    let bestMatch: SourceMapPosition | null = null;

    for (const segment of generatedSegments.split(",")) {
      if (!segment) continue;

      const decoded = decodeVlqSegment(segment);
      if (decoded.length === 0) continue;

      generatedSegmentColumn += decoded[0] ?? 0;
      if (decoded.length >= 4) {
        sourceIndex += decoded[1] ?? 0;
        originalLine += decoded[2] ?? 0;
        originalColumn += decoded[3] ?? 0;
      }

      if (generatedLineIndex !== targetLineIndex) continue;
      if (generatedSegmentColumn > targetColumn) break;

      bestMatch =
        decoded.length >= 4 && sourceMap.sources[sourceIndex]
          ? {
              source: sourceMap.sources[sourceIndex]!,
              line: originalLine + 1,
              column: originalColumn + 1,
            }
          : null;
    }

    if (generatedLineIndex === targetLineIndex) return bestMatch;
  }

  return null;
}

export function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;

  for (const char of segment) {
    const integer = BASE64_VLQ_VALUES[char];
    if (integer === undefined) return [];

    value += (integer & 31) << shift;
    if (integer & 32) {
      shift += 5;
      continue;
    }

    values.push(value & 1 ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }

  return values;
}

export function resolveSourceFile(
  source: string,
  sourceMap: SourceMapPayload,
  generatedUrl: URL,
): string {
  const rootedSource = sourceMap.sourceRoot
    ? `${sourceMap.sourceRoot.replace(/\/?$/, "/")}${source}`
    : source;
  try {
    return new URL(rootedSource, generatedUrl.href).href;
  } catch {
    return source;
  }
}
