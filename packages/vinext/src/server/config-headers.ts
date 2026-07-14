import type { NextHeader } from "../config/next-config.js";
import {
  matchHeaders,
  type BasePathMatchState,
  type RequestContext,
} from "../config/config-matchers.js";
import type { HeaderRecord } from "./request-pipeline.js";

type ApplyConfigHeadersOptions = {
  configHeaders: NextHeader[];
  pathname: string;
  requestContext: RequestContext;
  /**
   * basePath gating state. When omitted, every rule is treated as a default
   * (basePath: true) rule for backward compatibility — callers that need to
   * support `basePath: false` headers must pass this in.
   */
  basePathState?: BasePathMatchState;
  /** Existing framework-generated headers that matching config rules may replace. */
  overwriteExisting?: ReadonlySet<string>;
};

function findHeaderRecordKey(headers: HeaderRecord, lowerName: string): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return key;
  }
  return undefined;
}

function appendHeaderRecord(headers: HeaderRecord, lowerName: string, value: string): void {
  const key = findHeaderRecordKey(headers, lowerName) ?? lowerName;
  const existing = headers[key];
  if (existing === undefined) {
    headers[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  headers[key] = [existing, value];
}

function appendVaryHeaderRecord(headers: HeaderRecord, value: string): void {
  const key = findHeaderRecordKey(headers, "vary") ?? "vary";
  const existing = headers[key];
  if (existing === undefined) {
    headers[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  headers[key] = existing + ", " + value;
}

/** Apply matched next.config.js headers to a Web Headers object. */
export function applyConfigHeadersToResponse(
  responseHeaders: Headers,
  options: ApplyConfigHeadersOptions,
): void {
  const matched = matchHeaders(
    options.pathname,
    options.configHeaders,
    options.requestContext,
    options.basePathState,
  );
  for (const header of matched) {
    const lowerName = header.key.toLowerCase();
    if (lowerName === "vary" || lowerName === "set-cookie") {
      responseHeaders.append(header.key, header.value);
    } else if (options.overwriteExisting?.has(lowerName) || !responseHeaders.has(lowerName)) {
      responseHeaders.set(header.key, header.value);
    }
  }
}

/** Apply matched next.config.js headers to an early response header record. */
export function applyConfigHeadersToHeaderRecord(
  headers: HeaderRecord,
  options: ApplyConfigHeadersOptions,
): void {
  const matched = matchHeaders(
    options.pathname,
    options.configHeaders,
    options.requestContext,
    options.basePathState,
  );
  for (const header of matched) {
    const lowerName = header.key.toLowerCase();
    if (lowerName === "set-cookie") {
      appendHeaderRecord(headers, lowerName, header.value);
    } else if (lowerName === "vary") {
      appendVaryHeaderRecord(headers, header.value);
    } else if (findHeaderRecordKey(headers, lowerName) === undefined) {
      headers[lowerName] = header.value;
    }
  }
}
