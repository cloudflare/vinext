import type { NextHeader } from "../config/next-config.js";
import {
  matchHeaders,
  type BasePathMatchState,
  type RequestContext,
} from "../config/config-matchers.js";
import type { HeaderRecord } from "./request-pipeline.js";
import {
  isRouteCacheabilityPolicyProvisional,
  markRouteCacheabilityPolicyExplicit,
} from "./cacheability-request.js";

const ADDITIVE_CONFIG_HEADER_NAMES = new Set(["set-cookie", "vary"]);
const CACHE_POLICY_HEADER_NAMES = new Set([
  "cache-control",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
]);

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
    ),
  );
  const hasMatchedCachePolicy = matched.some((header) =>
    CACHE_POLICY_HEADER_NAMES.has(header.key.toLowerCase()),
  );
  if (hasMatchedCachePolicy && isRouteCacheabilityPolicyProvisional(responseHeaders)) {
    for (const name of CACHE_POLICY_HEADER_NAMES) responseHeaders.delete(name);
  }
  let appliedCachePolicy = false;
  for (const header of matched) {
    const lowerName = header.key.toLowerCase();
    if (lowerName === "link") {
      if (options.middlewareHeaders?.get(lowerName)) continue;

      const postConfigLink = options.appendToPostConfigLink ? responseHeaders.get(lowerName) : null;
      responseHeaders.set(
        header.key,
        postConfigLink ? `${header.value}, ${postConfigLink}` : header.value,
      );
    } else if (ADDITIVE_CONFIG_HEADER_NAMES.has(lowerName)) {
      responseHeaders.append(header.key, header.value);
    } else if (options.overwriteExisting?.has(lowerName) || !responseHeaders.has(lowerName)) {
      responseHeaders.set(header.key, header.value);
      if (CACHE_POLICY_HEADER_NAMES.has(lowerName)) appliedCachePolicy = true;
    }
  }
  if (appliedCachePolicy) {
    const policy = ["Cloudflare-CDN-Cache-Control", "CDN-Cache-Control", "Cache-Control"]
      .map((name) => ({ name, value: responseHeaders.get(name) }))
      .find((candidate) => candidate.value !== null);
    if (policy?.value !== null && policy?.value !== undefined) {
      markRouteCacheabilityPolicyExplicit(policy.value, policy.name);
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
    ),
  );
  let appliedCachePolicy = false;
  for (const header of matched) {
    const lowerName = header.key.toLowerCase();
    if (lowerName === "set-cookie") {
      appendHeaderRecord(headers, lowerName, header.value);
    } else if (lowerName === "vary") {
      appendVaryHeaderRecord(headers, header.value);
    } else if (findHeaderRecordKey(headers, lowerName) === undefined) {
      headers[lowerName] = header.value;
      if (CACHE_POLICY_HEADER_NAMES.has(lowerName)) appliedCachePolicy = true;
    }
  }
  if (appliedCachePolicy) {
    const cachePolicies = new Map(
      matched
        .filter((header) => CACHE_POLICY_HEADER_NAMES.has(header.key.toLowerCase()))
        .map((header) => [header.key.toLowerCase(), header.value]),
    );
    const policy = ["cloudflare-cdn-cache-control", "cdn-cache-control", "cache-control"]
      .map((name) => ({ name, value: cachePolicies.get(name) }))
      .find((candidate) => candidate.value !== undefined);
    if (policy?.value !== undefined) markRouteCacheabilityPolicyExplicit(policy.value, policy.name);
  }
}
