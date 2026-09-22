import { hasBasePath } from "../../utils/base-path.js";
import { getWindowOrigin, isAbsoluteUrl } from "../url-utils.js";

/**
 * Warn about and normalize repeated path separators like Next.js `resolveHref`.
 * The protocol separator is preserved and query strings are left untouched.
 *
 * Ported from Next.js: packages/next/src/client/resolve-href.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/resolve-href.ts
 */
export function normalizeRouterHref(href: string, routePathname: string): string {
  const protocol = href.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0] ?? "";
  const withoutProtocol = protocol ? href.slice(protocol.length) : href;
  if (!/(\/\/|\\)/.test(withoutProtocol.split("?", 1)[0] ?? "")) return href;

  console.error(
    `Invalid href '${href}' passed to next/router in page: '${routePathname}'. Repeated forward-slashes (//) or backslashes \\ are not valid in the href.`,
  );

  const [pathname, ...query] = withoutProtocol.split("?");
  const normalizedPathname = pathname.replace(/\\/g, "/").replace(/\/\/+/g, "/");
  return protocol + normalizedPathname + (query[0] ? `?${query.join("?")}` : "");
}

/** Resolve a Pages Router href against the route state used by Next.js Link. */
export function resolvePagesRouterHref(
  href: string,
  router: { pathname: string; asPath: string },
  basePath: string,
): string {
  const normalized = normalizeRouterHref(href, router.pathname);

  if (isAbsoluteUrl(normalized)) {
    const origin = getWindowOrigin();
    if (!origin) return normalized;
    try {
      const target = new URL(normalized, origin);
      if (
        target.origin !== origin ||
        (basePath !== "" && !hasBasePath(target.pathname, basePath))
      ) {
        return normalized;
      }
    } catch {
      return normalized;
    }
  }

  try {
    const base = new URL(normalized.startsWith("#") ? router.asPath : router.pathname, "http://n");
    const resolved = new URL(normalized, base);
    return resolved.origin === base.origin
      ? resolved.href.slice(resolved.origin.length)
      : resolved.href;
  } catch {
    return normalized;
  }
}
