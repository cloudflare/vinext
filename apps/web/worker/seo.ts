const CANONICAL_HOSTNAME = "vinext.dev";
const WWW_HOSTNAME = "www.vinext.dev";
const PRODUCTION_WORKERS_HOSTNAME = "vinext-web.vinext.workers.dev";
const PREVIEW_HOST_SUFFIX = `-${PRODUCTION_WORKERS_HOSTNAME}`;

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
  const isAlternateHost =
    url.hostname === WWW_HOSTNAME || url.hostname === PRODUCTION_WORKERS_HOSTNAME;
  const isInsecureCanonicalUrl = url.hostname === CANONICAL_HOSTNAME && url.protocol === "http:";
  if (!isAlternateHost && !isInsecureCanonicalUrl) return null;

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

/** Prevent public preview aliases from competing with the production domain. */
export function addPreviewRobotsHeader(request: Request, response: Response): Response {
  const { hostname } = new URL(request.url);
  if (!hostname.endsWith(PREVIEW_HOST_SUFFIX)) return response;

  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
