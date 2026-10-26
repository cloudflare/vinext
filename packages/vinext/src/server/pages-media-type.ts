import { parse } from "content-type";
import iconv from "iconv-lite";

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

export function isJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType === "application/ld+json";
}

/** Match Next.js parse-body: malformed Content-Type falls back to UTF-8 text. */
export function createPagesBodyDecoder(contentType: string | null | undefined) {
  let parsed;
  try {
    parsed = parse(contentType || "text/plain");
  } catch {
    parsed = parse("text/plain");
  }
  const charset = parsed.parameters.charset || "utf-8";
  if (!iconv.encodingExists(charset)) {
    throw new PagesBodyParseError("Invalid body", 400);
  }
  return { mediaType: parsed.type, decoder: iconv.getDecoder(charset) };
}
