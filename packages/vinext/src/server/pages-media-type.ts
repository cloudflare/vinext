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

// Grammar from the `content-type` package Next.js bundles
// (next/dist/compiled/content-type), so a header it rejects falls back the same way.
const TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PARAM_REGEXP =
  // oxlint-disable-next-line no-control-regex
  /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\u000b\u0020-\u00ff])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g;
// oxlint-disable-next-line no-control-regex
const QESC_REGEXP = /\\([\u000b\u0020-\u00ff])/g;

type ParsedContentType = { mediaType: string; charset: string | undefined };

function parseContentType(header: string): ParsedContentType | null {
  let index = header.indexOf(";");
  const type = (index === -1 ? header : header.slice(0, index)).trim();
  if (!TYPE_REGEXP.test(type)) return null;
  let charset: string | undefined;
  if (index !== -1) {
    const paramRegexp = new RegExp(PARAM_REGEXP);
    paramRegexp.lastIndex = index;
    let match: RegExpExecArray | null;
    while ((match = paramRegexp.exec(header))) {
      if (match.index !== index) return null;
      index += match[0].length;
      if (match[1].toLowerCase() !== "charset") continue;
      const value = match[2];
      charset = value.startsWith('"') ? value.slice(1, -1).replace(QESC_REGEXP, "$1") : value;
    }
    if (index !== header.length) return null;
  }
  return { mediaType: type.toLowerCase(), charset };
}

/**
 * Resolve the media type and body decoder for a Pages API request, matching
 * Next.js `parseBody()`: a malformed Content-Type is treated as `text/plain`,
 * the body is decoded with its `charset` (UTF-8 by default), and a charset that
 * can't be decoded is rejected with `400 Invalid body`.
 *
 * Next.js decodes with iconv-lite; vinext uses the platform `TextDecoder`, so
 * charsets resolve by WHATWG Encoding labels (for example `iso-8859-1` decodes
 * as windows-1252).
 */
export function createPagesBodyDecoder(contentType: string | null | undefined): {
  mediaType: string;
  decoder: TextDecoder;
} {
  const parsed = (contentType && parseContentType(contentType)) || {
    mediaType: "text/plain",
    charset: undefined,
  };
  try {
    return { mediaType: parsed.mediaType, decoder: new TextDecoder(parsed.charset || "utf-8") };
  } catch {
    throw new PagesBodyParseError("Invalid body", 400);
  }
}
