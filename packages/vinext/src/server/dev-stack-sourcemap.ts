import type { ViteDevServer } from "vite";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { VINEXT_ORIGINAL_STACK_TRACE_ENDPOINT } from "../utils/dev-stack-sourcemap-endpoint.js";

export { VINEXT_ORIGINAL_STACK_TRACE_ENDPOINT } from "../utils/dev-stack-sourcemap-endpoint.js";

const MAX_ORIGINAL_STACK_TRACE_BODY_BYTES = 1024 * 1024;

export type SourceMapPayload = {
  version?: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  sourceRoot?: string;
  mappings: string;
  ignoreList?: number[];
};

type SourceMapPosition = {
  source: string;
  line: number;
  column: number;
};

type SourceMapTracePosition = SourceMapPosition & {
  sourceIndex: number;
};

type ResolvedStackTracePayload = {
  stack: string;
  ignoredFrames: boolean[];
  projectRoot?: string;
  codeFrame?: StackCodeFramePayload;
};

type StackCodeFramePayload = {
  file: string;
  line: number;
  column: number;
  methodName?: string;
  lines: StackCodeFrameLine[];
};

type StackCodeFrameLine = {
  line: number;
  text: string;
  isErrorLine: boolean;
};

type GeneratedFrame = {
  cacheKey: string;
  sourceMapBaseUrl: URL;
  transform: () => Promise<SourceMapPayload | null>;
};

type MappedStackLine = {
  line: string;
  isFrame: boolean;
  ignored: boolean;
  codeFrame?: StackCodeFramePayload;
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

    const stackTrace = await resolveDevServerStackTrace(
      server,
      payload.stack,
      getDevStackSourcemapRequestHost(req.headers),
    );
    writeJson(res, 200, stackTrace);
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
): Promise<ResolvedStackTracePayload> {
  const sourceMapCache = new Map<string, Promise<SourceMapPayload | null>>();
  const mapped = await Promise.all(
    stack
      .split("\n")
      .map((line) => mapStackLineWithMetadata(server, line, requestHost, sourceMapCache)),
  );
  const codeFrame = mapped.find(
    (line) => line.isFrame && !line.ignored && line.codeFrame,
  )?.codeFrame;
  const projectRoot = normalizeProjectRoot(server.config?.root);
  return {
    stack: mapped.map((line) => line.line).join("\n"),
    ignoredFrames: createIgnoredFramesForOverlay(mapped),
    ...(projectRoot ? { projectRoot } : {}),
    ...(codeFrame ? { codeFrame } : {}),
  };
}

export async function mapStackLine(
  server: ViteDevServer,
  line: string,
  requestHost: string | undefined,
  sourceMapCache: Map<string, Promise<SourceMapPayload | null>>,
): Promise<string> {
  return (await mapStackLineWithMetadata(server, line, requestHost, sourceMapCache)).line;
}

export async function mapStackLineWithMetadata(
  server: ViteDevServer,
  line: string,
  requestHost: string | undefined,
  sourceMapCache: Map<string, Promise<SourceMapPayload | null>>,
): Promise<MappedStackLine> {
  const v8Paren = line.match(V8_PAREN_STACK_LINE);
  if (v8Paren) {
    const methodName = extractV8ParenMethodName(v8Paren[1]);
    const mapped = await mapGeneratedFrame(
      server,
      v8Paren[2],
      v8Paren[3],
      v8Paren[4],
      methodName,
      requestHost,
      sourceMapCache,
    );
    return {
      line: mapped
        ? `${v8Paren[1]}${mapped.file}:${mapped.line}:${mapped.column}${v8Paren[5]}`
        : line,
      isFrame: true,
      ignored: mapped?.ignored ?? isIgnoreListedGeneratedFrame(v8Paren[2], requestHost),
      ...(mapped?.codeFrame ? { codeFrame: mapped.codeFrame } : {}),
    };
  }

  const v8Bare = line.match(V8_BARE_STACK_LINE);
  if (v8Bare) {
    const mapped = await mapGeneratedFrame(
      server,
      v8Bare[2],
      v8Bare[3],
      v8Bare[4],
      undefined,
      requestHost,
      sourceMapCache,
    );
    return {
      line: mapped
        ? `${v8Bare[1]}${mapped.file}:${mapped.line}:${mapped.column}${v8Bare[5]}`
        : line,
      isFrame: true,
      ignored: mapped?.ignored ?? isIgnoreListedGeneratedFrame(v8Bare[2], requestHost),
      ...(mapped?.codeFrame ? { codeFrame: mapped.codeFrame } : {}),
    };
  }

  const moz = line.match(MOZ_STACK_LINE);
  if (moz) {
    const mapped = await mapGeneratedFrame(
      server,
      moz[2],
      moz[3],
      moz[4],
      moz[1].replace(/@$/, "") || undefined,
      requestHost,
      sourceMapCache,
    );
    return {
      line: mapped ? `${moz[1]}${mapped.file}:${mapped.line}:${mapped.column}${moz[5]}` : line,
      isFrame: true,
      ignored: mapped?.ignored ?? isIgnoreListedGeneratedFrame(moz[2], requestHost),
      ...(mapped?.codeFrame ? { codeFrame: mapped.codeFrame } : {}),
    };
  }

  return { line, isFrame: false, ignored: false };
}

function createIgnoredFramesForOverlay(mapped: readonly MappedStackLine[]): boolean[] {
  const firstNonEmptyLineIndex = mapped.findIndex((line) => line.line.trim() !== "");
  const nonEmptyLineCount = mapped.reduce(
    (count, line) => count + (line.line.trim() !== "" ? 1 : 0),
    0,
  );
  const firstLineIsMessage =
    nonEmptyLineCount > 1 &&
    firstNonEmptyLineIndex !== -1 &&
    !mapped[firstNonEmptyLineIndex]?.isFrame;

  return mapped.flatMap((line, index) => {
    if (line.line.trim() === "") return [];
    if (firstLineIsMessage && index === firstNonEmptyLineIndex) return [];
    return [line.isFrame ? line.ignored : false];
  });
}

async function mapGeneratedFrame(
  server: ViteDevServer,
  file: string,
  line: string,
  column: string,
  methodName: string | undefined,
  requestHost: string | undefined,
  sourceMapCache: Map<string, Promise<SourceMapPayload | null>>,
): Promise<{
  file: string;
  line: number;
  column: number;
  ignored: boolean;
  codeFrame?: StackCodeFramePayload;
} | null> {
  const generatedFrame = getMappableGeneratedFrame(server, file, requestHost);
  if (!generatedFrame) return null;

  const generatedLine = Number(line);
  const generatedColumn = Number(column);
  if (!Number.isFinite(generatedLine) || !Number.isFinite(generatedColumn)) return null;

  const sourceMap = await getSourceMapForGeneratedFrame(generatedFrame, sourceMapCache);
  if (!sourceMap) return null;

  const original = traceOriginalPositionFor(sourceMap, generatedLine, generatedColumn);
  if (!original) return null;

  const originalFile = resolveSourceFile(
    original.source,
    sourceMap,
    generatedFrame.sourceMapBaseUrl,
  );
  const codeFrame = await createStackCodeFrame({
    file: originalFile,
    line: original.line,
    column: original.column,
    methodName,
    sourceContent: sourceMap.sourcesContent?.[original.sourceIndex] ?? null,
  });
  return {
    file: originalFile,
    line: original.line,
    column: original.column,
    ignored:
      isSourceMapIgnored(sourceMap, original.sourceIndex) ||
      isIgnoreListedOriginalFrame(original.source) ||
      isIgnoreListedOriginalFrame(originalFile) ||
      isIgnoreListedGeneratedFrame(file, requestHost),
    ...(codeFrame ? { codeFrame } : {}),
  };
}

function extractV8ParenMethodName(prefix: string): string | undefined {
  const methodName = prefix
    .replace(/^\s*at\s+/, "")
    .replace(/\($/, "")
    .trim();
  return methodName || undefined;
}

function normalizeProjectRoot(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const normalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized || (root.startsWith("/") ? "/" : undefined);
}

function stripTrailingSlash(value: string | undefined): string | undefined {
  return value?.replace(/[\\/]+$/, "");
}

function stripQuery(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value;
}

function getMappableGeneratedFrame(
  server: ViteDevServer,
  file: string,
  requestHost: string | undefined,
): GeneratedFrame | null {
  const normalizedFile = devirtualizeReactServerFrame(file);
  const localPath = getLocalSourcePath(server, normalizedFile);
  if (localPath) {
    return {
      cacheKey: `server:${localPath}`,
      sourceMapBaseUrl: pathToFileURL(localPath),
      transform: () => loadServerSourceMapForLocalPath(server, localPath),
    };
  }
  if (isWindowsAbsolutePath(normalizedFile)) return null;

  const generatedUrl = getMappableClientGeneratedUrl(normalizedFile, requestHost);
  if (!generatedUrl) return null;
  const viteUrl = generatedUrl.pathname + generatedUrl.search;
  return {
    cacheKey: `client:${viteUrl}`,
    sourceMapBaseUrl: generatedUrl,
    transform: () => loadClientSourceMapForGeneratedUrl(server, viteUrl),
  };
}

function devirtualizeReactServerFrame(file: string): string {
  if (!file.startsWith("about://React/")) return file;
  const envIdx = file.indexOf("/", "about://React/".length);
  const suffixIdx = file.lastIndexOf("?");
  if (envIdx === -1 || suffixIdx === -1 || suffixIdx <= envIdx) return file;
  return file.slice(envIdx + 1, suffixIdx);
}

function getLocalSourcePath(server: ViteDevServer, file: string): string | null {
  let localPath = file;
  if (file.startsWith("file://")) {
    try {
      localPath = fileURLToPath(file);
    } catch {
      return null;
    }
  }

  localPath = stripQuery(localPath);
  if (!isAbsolutePath(localPath)) return null;
  const localPathForCompare = normalizeLocalPathForCompare(localPath);
  if (localPathForCompare.includes("/node_modules/")) return null;

  const root = server.config?.root;
  if (!root) return null;
  const rootForCompare = normalizeLocalPathForCompare(root);
  return localPathForCompare === rootForCompare ||
    localPathForCompare.startsWith(`${rootForCompare}/`)
    ? localPath
    : null;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeLocalPathForCompare(value: string): string {
  const normalized = (stripTrailingSlash(value.replaceAll("\\", "/")) ?? "").replace(/\/+/g, "/");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function normalizeIgnoreListPath(value: string): string {
  let path = devirtualizeReactServerFrame(value);
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      // Keep malformed file URLs comparable instead of dropping the frame.
    }
  } else {
    try {
      const url = new URL(path);
      if (url.protocol === "http:" || url.protocol === "https:") {
        path = `${url.pathname}${url.search}`;
      }
    } catch {
      // Plain filesystem paths and virtual module ids are expected here.
    }
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep malformed paths comparable instead of dropping the frame.
  }

  return path.replaceAll("\\", "/").toLowerCase();
}

function isExternalHttpFrame(file: string, requestHost: string | undefined): boolean {
  if (!/^https?:\/\//i.test(file) || !requestHost) return false;
  try {
    return new URL(file).host.toLowerCase() !== requestHost;
  } catch {
    return false;
  }
}

function isIgnoreListedGeneratedFrame(file: string, requestHost?: string): boolean {
  const normalized = normalizeIgnoreListPath(file);
  return (
    isExternalHttpFrame(file, requestHost) ||
    normalized.startsWith("node:") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/.vite/") ||
    normalized.includes("/@vite/") ||
    normalized.includes("/@react-refresh") ||
    normalized.includes("/__vite") ||
    normalized.includes("virtual:vinext") ||
    normalized.includes("/packages/vinext/src/") ||
    normalized.includes("/packages/vinext/dist/") ||
    normalized.includes("/vinext/server/")
  );
}

function isIgnoreListedOriginalFrame(file: string): boolean {
  const normalized = normalizeIgnoreListPath(file);
  return (
    normalized.startsWith("node:") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/packages/vinext/src/") ||
    normalized.includes("/packages/vinext/dist/") ||
    normalized.includes("/vinext/server/")
  );
}

function isSourceMapIgnored(sourceMap: SourceMapPayload, sourceIndex: number): boolean {
  return sourceMap.ignoreList?.includes(sourceIndex) ?? false;
}

async function createStackCodeFrame({
  file,
  line,
  column,
  methodName,
  sourceContent,
}: {
  file: string;
  line: number;
  column: number;
  methodName: string | undefined;
  sourceContent: string | null;
}): Promise<StackCodeFramePayload | null> {
  const source = sourceContent ?? (await readSourceFileForCodeFrame(file));
  if (!source) return null;

  const sourceLines = source.split(/\r\n|\r|\n/);
  if (line < 1 || line > sourceLines.length) return null;

  const start = Math.max(1, line - 2);
  const end = Math.min(sourceLines.length, line + 3);
  const lines: StackCodeFrameLine[] = [];
  for (let currentLine = start; currentLine <= end; currentLine++) {
    lines.push({
      line: currentLine,
      text: sourceLines[currentLine - 1] ?? "",
      isErrorLine: currentLine === line,
    });
  }

  return {
    file,
    line,
    column,
    ...(methodName ? { methodName } : {}),
    lines,
  };
}

async function readSourceFileForCodeFrame(file: string): Promise<string | null> {
  if (!file.startsWith("file://")) return null;
  try {
    return await readFile(fileURLToPath(file), "utf8");
  } catch {
    return null;
  }
}

function getMappableClientGeneratedUrl(file: string, requestHost: string | undefined): URL | null {
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

async function getSourceMapForGeneratedFrame(
  generatedFrame: GeneratedFrame,
  cache: Map<string, Promise<SourceMapPayload | null>>,
): Promise<SourceMapPayload | null> {
  let sourceMap = cache.get(generatedFrame.cacheKey);
  if (!sourceMap) {
    sourceMap = generatedFrame.transform();
    cache.set(generatedFrame.cacheKey, sourceMap);
  }
  return sourceMap;
}

async function loadClientSourceMapForGeneratedUrl(
  server: ViteDevServer,
  viteUrl: string,
): Promise<SourceMapPayload | null> {
  try {
    const result = await server.environments.client.transformRequest(viteUrl);
    return normalizeSourceMapPayload(result?.map);
  } catch {
    return null;
  }
}

async function loadServerSourceMapForLocalPath(
  server: ViteDevServer,
  localPath: string,
): Promise<SourceMapPayload | null> {
  for (const environmentName of ["rsc", "ssr"]) {
    const environment = server.environments[environmentName];
    if (!environment) continue;
    try {
      const result = await environment.transformRequest(localPath);
      const sourceMap = normalizeSourceMapPayload(result?.map);
      if (sourceMap) return sourceMap;
    } catch {
      // Try the next environment. Some frames are RSC-only or SSR-only.
    }
  }
  return null;
}

function normalizeSourceMapPayload(payload: unknown): SourceMapPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const map = payload as {
    version?: unknown;
    sources?: unknown;
    sourcesContent?: unknown;
    sourceRoot?: unknown;
    mappings?: unknown;
    ignoreList?: unknown;
    x_google_ignoreList?: unknown;
  };
  if (!Array.isArray(map.sources) || typeof map.mappings !== "string" || map.mappings === "") {
    return null;
  }
  if (!map.sources.every((source): source is string => typeof source === "string")) return null;
  const ignoreList =
    normalizeIgnoreList(map.ignoreList) ?? normalizeIgnoreList(map.x_google_ignoreList);
  return {
    version: typeof map.version === "number" ? map.version : undefined,
    sources: map.sources,
    sourcesContent: normalizeSourcesContent(map.sourcesContent),
    sourceRoot: typeof map.sourceRoot === "string" ? map.sourceRoot : undefined,
    mappings: map.mappings,
    ignoreList,
  };
}

function normalizeSourcesContent(value: unknown): (string | null)[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sourcesContent = value.map((source) => (typeof source === "string" ? source : null));
  return sourcesContent.length > 0 ? sourcesContent : undefined;
}

function normalizeIgnoreList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ignoreList = value.filter(
    (index): index is number => Number.isInteger(index) && index >= 0,
  );
  return ignoreList.length > 0 ? ignoreList : undefined;
}

export function originalPositionFor(
  sourceMap: SourceMapPayload,
  generatedLine: number,
  generatedColumn: number,
): SourceMapPosition | null {
  const original = traceOriginalPositionFor(sourceMap, generatedLine, generatedColumn);
  if (!original) return null;
  return {
    source: original.source,
    line: original.line,
    column: original.column,
  };
}

function traceOriginalPositionFor(
  sourceMap: SourceMapPayload,
  generatedLine: number,
  generatedColumn: number,
): SourceMapTracePosition | null {
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
    let bestMatch: SourceMapTracePosition | null = null;

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
              sourceIndex,
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
