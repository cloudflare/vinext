/**
 * Shared media-type helpers and body-parse error for Pages API routes.
 *
 * Used by both api-handler.ts (Pages Router dev/prod with Node.js req/res) and
 * pages-node-compat.ts (Pages Router fetch-based facade for Cloudflare Workers).
 */

export class PagesBodyParseError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "PagesBodyParseError";
  }
}

export function getMediaType(contentType: string | null | undefined): string {
  const [type] = (contentType ?? "text/plain").split(";");
  return type?.trim().toLowerCase() || "text/plain";
}

export function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType === "application/ld+json";
}
