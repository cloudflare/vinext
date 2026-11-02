import { Buffer } from "node:buffer";

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

/** A `TextDecoder`-shaped decoder for one request body. */
export type PagesBodyDecoder = {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
};

// CESU-8's end() returns 0 when nothing is pending, so join it like raw-body
// does (`decoder.end() || ""`).
type IconvDecoder = { write(buffer: Buffer): string; end(): string | number | undefined };

function iconvBodyDecoder(decoder: IconvDecoder): PagesBodyDecoder {
  return {
    decode(input, options) {
      let text = input
        ? decoder.write(Buffer.from(input.buffer, input.byteOffset, input.byteLength))
        : "";
      if (!options?.stream) text += decoder.end() || "";
      return text;
    },
  };
}

/**
 * Resolve the media type and body decoder for a Pages API request, matching
 * Next.js `parseBody()`: a malformed Content-Type is treated as `text/plain`,
 * the body is decoded with its `charset` (UTF-8 by default), and a charset that
 * can't be decoded is rejected with `400 Invalid body`.
 *
 * Next.js decodes through raw-body with iconv-lite 0.4, which vinext bundles
 * at the same version. It is loaded only for non-UTF-8 charsets: `TextDecoder`
 * decodes UTF-8 identically, BOM stripping included, and keeps iconv-lite's
 * encoding tables out of the startup path.
 */
export async function createPagesBodyDecoder(contentType: string | null | undefined): Promise<{
  mediaType: string;
  decoder: PagesBodyDecoder;
}> {
  const parsed = (contentType && parseContentType(contentType)) || {
    mediaType: "text/plain",
    charset: undefined,
  };
  const charset = parsed.charset || "utf-8";
  // iconv-lite's encoding-name canonicalization.
  if (charset.toLowerCase().replace(/:\d{4}$|[^0-9a-z]/g, "") === "utf8") {
    return { mediaType: parsed.mediaType, decoder: new TextDecoder() };
  }
  // iconv-lite 0.4's typings omit getDecoder(), the streaming API raw-body uses.
  const iconv = (await import("iconv-lite")).default as typeof import("iconv-lite") & {
    getDecoder(encoding: string): IconvDecoder;
  };
  let decoder: IconvDecoder;
  try {
    decoder = iconv.getDecoder(charset);
  } catch {
    // Next.js answers 400 for any raw-body failure, including names such as
    // "constructor" that iconv-lite resolves on Object.prototype.
    throw new PagesBodyParseError("Invalid body", 400);
  }
  return { mediaType: parsed.mediaType, decoder: iconvBodyDecoder(decoder) };
}
