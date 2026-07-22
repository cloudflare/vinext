/**
 * Shared `res.revalidate()` implementation for the Pages Router.
 *
 * `res.revalidate(urlPath)` triggers on-demand ISR regeneration of a Pages
 * Router route. It mirrors Next.js's api-resolver `revalidate()` helper
 * (`.nextjs-ref/packages/next/src/server/api-utils/node/api-resolver.ts`): it
 * issues an internal `HEAD` request to `urlPath` carrying the
 * `x-prerender-revalidate` header set to the build-time revalidate secret
 * (Next.js sends `context.previewModeId` here). The dev/prod Pages render path
 * authorizes the request only when that value *equals* the secret
 * (`isOnDemandRevalidateRequest`), then re-runs getStaticProps with
 * `revalidateReason: "on-demand"` and refreshes the cache entry.
 *
 * Both the Node-compat (`pages-node-compat.ts`) and prod (`api-handler.ts`)
 * response objects delegate here so the secret wiring and success detection
 * never drift between dev and prod.
 */
import type { IncomingMessage } from "node:http";
import { resolveRequestProtocol, resolveRequestHost } from "./proxy-trust.js";
import {
  PRERENDER_REVALIDATE_HEADER,
  PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER,
  getRevalidateSecret,
  isOnDemandRevalidateRequest,
} from "./isr-cache.js";
import { NEXTJS_CACHE_HEADER, VINEXT_REVALIDATE_HOST_HEADER } from "./headers.js";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { normalizeDomainHostname } from "../utils/domain-locale.js";

export type RevalidateOptions = {
  /**
   * Only revalidate the path if it was already generated (cached). Mirrors
   * Next.js's `unstable_onlyGenerated`: sets the
   * `x-prerender-revalidate-if-generated` header and makes a 404 response count
   * as a successful no-op rather than an error.
   */
  unstable_onlyGenerated?: boolean;
};

export async function performOnDemandRevalidate(
  source: IncomingMessage | Headers,
  urlPath: string,
  opts: RevalidateOptions = {},
  trustedOrigin?: string,
  allowedRevalidateHeaderKeys: readonly string[] = [],
  dev = false,
): Promise<void> {
  if (typeof urlPath !== "string" || !urlPath.startsWith("/")) {
    throw new Error(
      `Invalid urlPath provided to revalidate(), must be a path e.g. /blog/post-1, received ${urlPath}`,
    );
  }

  if (isSourceRevalidationRequest(source)) {
    throw new Error(`Cannot revalidate ${urlPath} from an internal revalidation request`);
  }

  const executionContext = getRequestExecutionContext();
  const dispatchRevalidate = executionContext?.dispatchPagesRevalidate;
  const target = createRevalidateTarget(source, urlPath, trustedOrigin);

  const headers: Record<string, string> = {
    [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret(),
  };
  if (trustedOrigin && !dispatchRevalidate) {
    const logicalHostname = normalizeDomainHostname(resolveRequestHost(source, "localhost"));
    if (logicalHostname) headers[VINEXT_REVALIDATE_HOST_HEADER] = logicalHostname;
  }
  if (opts.unstable_onlyGenerated) {
    headers[PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER] = "1";
  }

  const allowedHeaders = new Set(allowedRevalidateHeaderKeys.map((key) => key.toLowerCase()));
  // Next.js forwards cookies automatically in development so local auth-gated
  // pages can be revalidated. Production credentials remain excluded unless
  // the application explicitly opts in through allowedRevalidateHeaderKeys.
  if (dev) allowedHeaders.add("cookie");
  for (const key of allowedHeaders) {
    const value = readSourceHeader(source, key);
    if (value !== undefined) headers[key] = value;
  }

  if (dispatchRevalidate && executionContext.isInternalPagesRevalidation) {
    throw new Error(`Cannot revalidate ${urlPath} from an internal revalidation request`);
  }

  const res = await fetchRevalidateTarget(target, headers, dispatchRevalidate);

  // Success detection mirrors Next.js's api-resolver: a successful revalidate
  // can return a non-200 status (e.g. `notFound: true` yields 404). Accept when
  // the cache header reports REVALIDATED, the status is 200, or the path was
  // not generated and the caller opted into `unstable_onlyGenerated`.
  //
  // `unstable_onlyGenerated` misses return 404 + REVALIDATED as a successful
  // no-op, matching Next.js. Ordinary successful regenerations return 200.
  const cacheHeader = res.headers.get("x-vercel-cache") ?? res.headers.get(NEXTJS_CACHE_HEADER);
  const ok =
    cacheHeader?.toUpperCase() === "REVALIDATED" ||
    res.status === 200 ||
    (res.status === 404 && opts.unstable_onlyGenerated === true);

  if (!ok) {
    throw new Error(`Failed to revalidate ${urlPath}: ${res.status}`);
  }
}

function readSourceHeader(source: IncomingMessage | Headers, key: string): string | undefined {
  if (isWebHeaders(source)) return source.get(key) ?? undefined;
  const value = source.headers[key];
  return Array.isArray(value) ? value.join(", ") : value;
}

function isSourceRevalidationRequest(source: IncomingMessage | Headers): boolean {
  const headerValue = isWebHeaders(source)
    ? source.get(PRERENDER_REVALIDATE_HEADER)
    : source.headers[PRERENDER_REVALIDATE_HEADER];
  return isOnDemandRevalidateRequest(headerValue);
}

function isWebHeaders(source: IncomingMessage | Headers): source is Headers {
  return typeof (source as Headers).get === "function";
}

async function fetchRevalidateTarget(
  initialTarget: URL,
  headers: Record<string, string>,
  dispatchRevalidate?: (request: Request) => Promise<Response>,
): Promise<Response> {
  const request = new Request(initialTarget, { method: "HEAD", headers, redirect: "manual" });
  // Worker runtimes dispatch this request back through vinext's in-process
  // request pipeline. A global same-origin fetch can bypass the Worker and
  // reach the zone origin unless global_fetch_strictly_public is enabled,
  // which would expose the baked revalidation credential. Node keeps the
  // upstream-compatible HTTP loopback when no dispatcher is installed.
  //
  // Do not follow redirects here. A redirect produced by getStaticProps is a
  // terminal regenerated representation and carries `REVALIDATED`; a config
  // redirect does not and must make `res.revalidate()` fail. Following either
  // would both erase that distinction and risk forwarding the secret.
  return dispatchRevalidate ? await dispatchRevalidate(request) : await fetch(request);
}

function createRevalidateTarget(
  source: IncomingMessage | Headers,
  urlPath: string,
  trustedOrigin?: string,
): URL {
  const origin = resolveRevalidateOrigin(source, trustedOrigin);
  const target = new URL(`${origin}${urlPath}`);
  if (target.origin !== origin) {
    throw new Error(
      `Invalid urlPath provided to revalidate(), resolved outside application origin`,
    );
  }
  return target;
}

function resolveRevalidateOrigin(
  source: IncomingMessage | Headers,
  trustedOrigin?: string,
): string {
  if (trustedOrigin) {
    return normalizeRevalidateOrigin(trustedOrigin);
  }

  const proto = resolveRequestProtocol(source);
  const host = resolveRequestHost(source, "localhost");
  return normalizeRevalidateOrigin(`${proto}://${host}`);
}

function normalizeRevalidateOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid revalidate origin protocol: ${parsed.protocol}`);
  }
  return parsed.origin;
}
