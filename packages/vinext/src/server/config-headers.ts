import type { NextHeader } from "../config/next-config.js";
import {
  matchHeaders,
  type BasePathMatchState,
  type RequestContext,
} from "../config/config-matchers.js";
import type { HeaderRecord } from "./request-pipeline.js";
import {
  CACHEABILITY_POLICY_HEADERS,
  markRouteCacheabilityDynamic,
  markRouteCacheabilityExplicitConfigPolicy,
  markRouteCacheabilityFinalResponseUncacheable,
} from "vinext/shims/cacheability-classification";
import { isNonCacheableCacheControl } from "vinext/shims/cdn-cache";

const ADDITIVE_CONFIG_HEADER_NAMES = new Set(["set-cookie", "vary"]);
const CACHEABILITY_POLICY_HEADER_NAMES = new Set<string>(CACHEABILITY_POLICY_HEADERS);

function markConditionalConfigHeaderCacheability(rule: NextHeader): void {
  if (
    [...(rule.has ?? []), ...(rule.missing ?? [])].some(
      (condition) =>
        condition.type === "header" || condition.type === "cookie" || condition.type === "host",
    )
  ) {
    // Query values are already part of the public Workers Cache key. Headers,
    // cookies, and hostnames are not, so a response header selected by any of
    // them cannot be shared safely under the request URL.
    markRouteCacheabilityDynamic(
      "next.config headers depend on request headers, cookies, or hostnames",
    );
  }
}

function markExplicitConfigResponseVeto(
  matched: ReadonlyArray<{ key: string; value: string }>,
): void {
  for (const header of matched) {
    const name = header.key.toLowerCase();
    if (name === "set-cookie") {
      markRouteCacheabilityFinalResponseUncacheable("next.config headers set a cookie");
      continue;
    }
    if (CACHEABILITY_POLICY_HEADER_NAMES.has(name)) {
      markRouteCacheabilityExplicitConfigPolicy();
    }
    if (CACHEABILITY_POLICY_HEADER_NAMES.has(name) && isNonCacheableCacheControl(header.value)) {
      markRouteCacheabilityFinalResponseUncacheable(
        `next.config headers set a non-cacheable ${header.key} policy`,
      );
    }
  }
}

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
  /** Renderer and Edge-handler Link values are emitted after config headers in Next.js. */
  appendToPostConfigLink?: boolean;
  /** Middleware response headers run after config and therefore suppress config values. */
  middlewareHeaders?: Headers | null;
};

function retainLastSingularConfigValues(
  matched: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  const lastIndexByName = new Map<string, number>();
  for (const [index, header] of matched.entries()) {
    const lowerName = header.key.toLowerCase();
    if (!ADDITIVE_CONFIG_HEADER_NAMES.has(lowerName)) {
      lastIndexByName.set(lowerName, index);
    }
  }

  return matched.filter((header, index) => {
    const lowerName = header.key.toLowerCase();
    return ADDITIVE_CONFIG_HEADER_NAMES.has(lowerName) || lastIndexByName.get(lowerName) === index;
  });
}

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
  const matched = retainLastSingularConfigValues(
    matchHeaders(
      options.pathname,
      options.configHeaders,
      options.requestContext,
      options.basePathState,
      markConditionalConfigHeaderCacheability,
    ),
  );
  markExplicitConfigResponseVeto(matched);
  for (const header of matched) {
    const lowerName = header.key.toLowerCase();
    if (lowerName === "link") {
      if (options.middlewareHeaders?.get(lowerName)) continue;

      const postConfigLink = options.appendToPostConfigLink ? responseHeaders.get(lowerName) : null;
      responseHeaders.set(
        header.key,
        postConfigLink ? `${header.value}, ${postConfigLink}` : header.value,
      );
    } else if (
      !ADDITIVE_CONFIG_HEADER_NAMES.has(lowerName) &&
      options.middlewareHeaders?.has(lowerName)
    ) {
      // Middleware runs after next.config headers in Next.js, so it remains
      // authoritative even when this config field may replace a renderer-owned
      // default (notably Cache-Control).
      continue;
    } else if (ADDITIVE_CONFIG_HEADER_NAMES.has(lowerName)) {
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
  const matched = retainLastSingularConfigValues(
    matchHeaders(
      options.pathname,
      options.configHeaders,
      options.requestContext,
      options.basePathState,
      markConditionalConfigHeaderCacheability,
    ),
  );
  markExplicitConfigResponseVeto(matched);
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
