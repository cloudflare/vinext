const CANONICAL_HOSTNAME = "vinext.dev";
const WWW_HOSTNAME = "www.vinext.dev";
const PRODUCTION_WORKERS_HOSTNAME = "vinext-web.vinext.workers.dev";
const WORKERS_HOST_SUFFIX = ".vinext.workers.dev";

function isPublicDocumentRequest(request: Request, url: URL): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/")
  );
}

/**
 * Consolidate public production traffic on vinext.dev while leaving the
 * workers.dev API endpoints available to existing CI upload jobs.
 */
export function getCanonicalRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (!isPublicDocumentRequest(request, url)) return null;
  if (url.hostname !== WWW_HOSTNAME && url.hostname !== PRODUCTION_WORKERS_HOSTNAME) return null;

  url.protocol = "https:";
  url.hostname = CANONICAL_HOSTNAME;
  url.port = "";

  return new Response(null, {
    status: 308,
    headers: {
      location: url.href,
      "cache-control": "public, max-age=3600",
    },
  });
}

/**
 * Keep every non-canonical host this Worker answers on out of the index.
 *
 * Covers preview aliases and the production workers.dev origin alike. Public
 * documents on the workers.dev origin already 308 to vinext.dev, but the /api/
 * carve-out above does not, so without this header those JSON endpoints stay
 * indexable on a host that competes with the canonical domain for the brand
 * term. Only vinext.dev itself is left untouched.
 */
export function addNonCanonicalRobotsHeader(request: Request, response: Response): Response {
  const { hostname } = new URL(request.url);
  if (!hostname.endsWith(WORKERS_HOST_SUFFIX)) return response;

  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
