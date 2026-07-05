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
import {
  PRERENDER_REVALIDATE_HEADER,
  PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER,
  getRevalidateSecret,
} from "./isr-cache.js";
import { NEXTJS_CACHE_HEADER } from "./headers.js";

export type RevalidateOptions = {
  /**
   * Only revalidate the path if it was already generated (cached). Mirrors
   * Next.js's `unstable_onlyGenerated`: sets the
   * `x-prerender-revalidate-if-generated` header and makes a 404 response count
   * as a successful no-op rather than an error.
   */
  unstable_onlyGenerated?: boolean;
};

type NodeRevalidateRequest = {
  socket: Pick<IncomingMessage["socket"], "localAddress" | "localPort"> & {
    encrypted?: boolean;
  };
};

function invalidUrlPathError(urlPath: unknown): Error {
  return new Error(
    `Invalid urlPath provided to revalidate(), must be a path e.g. /blog/post-1, received ${String(urlPath)}`,
  );
}

function isAuthorityLikePath(urlPath: string): boolean {
  const withoutUrlWhitespace = urlPath.replace(/[\t\n\r]/g, "");
  return /^[/\\]{2}/.test(withoutUrlWhitespace);
}

const MAX_REVALIDATE_REDIRECTS = 5;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function resolveNodeRevalidateOrigin(source: NodeRevalidateRequest): string {
  const { localAddress, localPort } = source.socket;
  if (!localAddress || !localPort) {
    throw new Error("Invariant: missing local server address for res.revalidate()");
  }

  const hostname = localAddress.includes(":") ? `[${localAddress}]` : localAddress;
  const protocol = source.socket.encrypted ? "https" : "http";
  return `${protocol}://${hostname}:${localPort}`;
}

export async function performOnDemandRevalidate(
  trustedOrigin: string,
  urlPath: string,
  opts: RevalidateOptions = {},
): Promise<void> {
  if (typeof urlPath !== "string" || !urlPath.startsWith("/") || isAuthorityLikePath(urlPath)) {
    throw invalidUrlPathError(urlPath);
  }

  // `trustedOrigin` must come from server-owned state: the local listening
  // socket on Node, or the platform-created Request URL on Workers. Never
  // derive it from the raw Host header because this request carries the
  // deployment-wide ISR revalidation secret.
  const origin = new URL(trustedOrigin).origin;
  let target = new URL(urlPath, origin);
  if (target.origin !== origin) {
    throw invalidUrlPathError(urlPath);
  }

  const headers: Record<string, string> = {
    [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret(),
  };
  if (opts.unstable_onlyGenerated) {
    headers[PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER] = "1";
  }

  let res: Response;
  for (let redirectCount = 0; ; redirectCount++) {
    res = await fetch(target, { method: "HEAD", headers, redirect: "manual" });
    if (!isRedirectStatus(res.status)) break;

    const location = res.headers.get("location");
    if (location === null || redirectCount === MAX_REVALIDATE_REDIRECTS) break;

    let redirectTarget: URL;
    try {
      redirectTarget = new URL(location, target);
    } catch {
      break;
    }
    if (redirectTarget.origin !== origin) break;
    target = redirectTarget;
  }

  // Success detection mirrors Next.js's api-resolver: a successful revalidate
  // can return a non-200 status (e.g. `notFound: true` yields 404). Accept when
  // the cache header reports REVALIDATED, the status is 200, or the path was
  // not generated and the caller opted into `unstable_onlyGenerated`.
  //
  // NOTE: vinext's Pages ISR path only ever emits HIT/MISS/STALE on
  // `x-nextjs-cache`, never REVALIDATED, so in practice the happy path is the
  // 200 branch. The REVALIDATED branch is kept for parity with Next.js and to
  // stay correct if that header is emitted in the future.
  const cacheHeader = res.headers.get(NEXTJS_CACHE_HEADER);
  const ok =
    cacheHeader?.toUpperCase() === "REVALIDATED" ||
    res.status === 200 ||
    (res.status === 404 && opts.unstable_onlyGenerated === true);

  if (!ok) {
    throw new Error(`Failed to revalidate ${urlPath}: ${res.status}`);
  }
}
