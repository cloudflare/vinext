// Ported from Next.js: packages/next/src/shared/lib/router/utils/format-url.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/format-url.ts

import type { UrlObject } from "node:url";
import { urlQueryToSearchParams, type UrlQuery } from "../../utils/query.js";

const slashedProtocols = /https?|ftp|gopher|file/;
const urlObjectKeys = new Set([
  "auth",
  "hash",
  "host",
  "hostname",
  "href",
  "path",
  "pathname",
  "port",
  "protocol",
  "query",
  "search",
  "slashes",
]);

/** Format Node's public UrlObject shape with the semantics used by Next.js. */
export function formatUrlObject(url: UrlObject): string {
  let { auth, hostname } = url;
  let protocol = url.protocol || "";
  let pathname = url.pathname || "";
  let hash = url.hash || "";
  let query = url.query || "";
  let host: string | false = false;

  // Next.js restores only the first encoded colon between user and password.
  // lgtm[js/incomplete-sanitization] — deliberate upstream-compatible single replacement
  auth = auth ? `${encodeURIComponent(auth).replace(/%3A/i, ":")}@` : "";
  if (url.host) {
    host = auth + url.host;
  } else if (hostname) {
    host = auth + (hostname.includes(":") ? `[${hostname}]` : hostname);
    if (url.port) host += `:${url.port}`;
  }

  if (query && typeof query === "object") {
    query = String(urlQueryToSearchParams(query as UrlQuery));
  }
  let search = url.search || (query && `?${query}`) || "";

  if (protocol && !protocol.endsWith(":")) protocol += ":";
  if (url.slashes || ((!protocol || slashedProtocols.test(protocol)) && host !== false)) {
    host = `//${host || ""}`;
    if (pathname && !pathname.startsWith("/")) pathname = `/${pathname}`;
  } else if (!host) {
    host = "";
  }

  if (hash && !hash.startsWith("#")) hash = `#${hash}`;
  if (search && !search.startsWith("?")) search = `?${search}`;

  pathname = pathname.replace(/[?#]/g, encodeURIComponent);
  // Next.js encodes only the first hash; later hashes remain fragment text.
  // lgtm[js/incomplete-sanitization] — deliberate upstream-compatible single replacement
  search = search.replace("#", "%23");
  return `${protocol}${host}${pathname}${search}${hash}`;
}

/** Format a Pages Router UrlObject and surface Next.js's development diagnostics. */
export function formatUrlObjectWithValidation(url: UrlObject): string {
  if (process.env.NODE_ENV === "development") {
    for (const key of Object.keys(url)) {
      if (!urlObjectKeys.has(key)) {
        console.warn(`Unknown key passed via urlObject into url.format: ${key}`);
      }
    }
  }
  return formatUrlObject(url);
}
