/**
 * Shared trust-boundary helpers for `X-Forwarded-*` headers.
 *
 * Any code path that derives `request.url` from attacker-controlled input
 * (proxy headers) must funnel through these helpers so the same
 * `VINEXT_TRUST_PROXY` / `VINEXT_TRUSTED_HOSTS` policy applies everywhere.
 *
 * The Node prod server, the dev server, and the dev bridge for edge API
 * routes all share this trust model. Without it, a client can send
 * `X-Forwarded-Proto: https` and trick handler code that gates on
 * `request.url.startsWith("https")` (e.g. Secure-cookie logic) into
 * believing the request arrived over TLS.
 *
 * See also: Finding F-PROD-7 in SECURITY-AUDIT-2026-05.md.
 */
import type { IncomingMessage } from "node:http";

/**
 * Header value as it appears on Node's `IncomingMessage.headers` (single
 * string, list of strings for repeated headers, or undefined) or as
 * returned by `Headers#get` on Fetch APIs (string | null).
 */
type RawHeaderValue = string | string[] | null | undefined;

function firstHeaderValue(value: RawHeaderValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Hosts that are allowed as `X-Forwarded-Host` values (stored lowercase).
 *
 * This Set is intentionally mutable so tests can add/remove entries
 * without reloading the module, and so existing call sites that imported
 * `trustedHosts` from `prod-server.ts` keep the same semantics.
 */
export const trustedHosts: Set<string> = new Set(
  (process.env.VINEXT_TRUSTED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Whether to trust `X-Forwarded-Proto` from upstream proxies.
 *
 * Enabled when `VINEXT_TRUST_PROXY=1` or when `VINEXT_TRUSTED_HOSTS` is
 * non-empty (having trusted hosts implies a trusted proxy). Computed at
 * module load time, matching the existing prod-server behavior.
 */
export const trustProxy: boolean = process.env.VINEXT_TRUST_PROXY === "1" || trustedHosts.size > 0;

/**
 * Resolve the request protocol, honoring `X-Forwarded-Proto` only when
 * the trust-proxy gate is enabled. Defaults to `"http"`.
 *
 * Accepts either a Node `IncomingMessage` or a Fetch `Headers` instance
 * so the same trust logic can be applied in both server flavors.
 */
export function resolveRequestProtocol(source: IncomingMessage | Headers): "http" | "https" {
  if (!trustProxy) return "http";
  const raw = readForwardedProto(source);
  const candidate = raw?.split(",")[0]?.trim();
  return candidate === "https" || candidate === "http" ? candidate : "http";
}

/**
 * Resolve the request host. `X-Forwarded-Host` is honored only when its
 * value matches the `trustedHosts` allow-list. Falls back to the raw
 * `Host` header and then to `fallback`.
 *
 * Ignoring `X-Forwarded-Host` by default prevents host header poisoning
 * (open redirects, cache poisoning) where an attacker sends
 * `X-Forwarded-Host: evil.com` to a server that resolves redirect URLs
 * against `request.url`.
 */
export function resolveRequestHost(source: IncomingMessage | Headers, fallback: string): string {
  const rawForwarded = readForwardedHost(source);
  if (rawForwarded && trustedHosts.size > 0) {
    // `X-Forwarded-Host` can be comma-separated when passing through
    // multiple proxies — take only the first (client-facing) value.
    const forwardedHost = rawForwarded.split(",")[0]?.trim().toLowerCase();
    if (forwardedHost && trustedHosts.has(forwardedHost)) {
      return forwardedHost;
    }
  }
  const hostHeader = readHost(source);
  return hostHeader || fallback;
}

function readForwardedProto(source: IncomingMessage | Headers): string | undefined {
  if (isWebHeaders(source)) return source.get("x-forwarded-proto") ?? undefined;
  return firstHeaderValue(source.headers["x-forwarded-proto"]);
}

function readForwardedHost(source: IncomingMessage | Headers): string | undefined {
  if (isWebHeaders(source)) return source.get("x-forwarded-host") ?? undefined;
  return firstHeaderValue(source.headers["x-forwarded-host"]);
}

function readHost(source: IncomingMessage | Headers): string | undefined {
  if (isWebHeaders(source)) return source.get("host") ?? undefined;
  return firstHeaderValue(source.headers["host"]);
}

function isWebHeaders(source: IncomingMessage | Headers): source is Headers {
  return typeof (source as Headers).get === "function";
}
