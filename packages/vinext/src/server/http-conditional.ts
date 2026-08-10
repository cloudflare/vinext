import { parseHttpDate } from "./http-date.js";

/**
 * Test an If-None-Match field value against a current entity tag.
 *
 * RFC 9110 requires weak comparison for If-None-Match: a weak and strong
 * validator with the same opaque tag compare equal.
 */
export function matchesIfNoneMatch(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;

  const current = parseEntityTag(etag, 0);
  if (!current || current.end !== etag.length) return false;
  const currentOpaqueTag = etag.slice(current.opaqueStart, current.opaqueEnd);

  let index = skipOptionalWhitespace(ifNoneMatch, 0);
  if (ifNoneMatch[index] === "*") {
    return skipOptionalWhitespace(ifNoneMatch, index + 1) === ifNoneMatch.length;
  }

  let matched = false;
  let sawTag = false;
  while (index < ifNoneMatch.length) {
    // RFC 9110's list extension allows recipients to ignore empty members.
    if (ifNoneMatch[index] === ",") {
      index = skipOptionalWhitespace(ifNoneMatch, index + 1);
      continue;
    }

    const candidate = parseEntityTag(ifNoneMatch, index);
    if (!candidate) return false;
    sawTag = true;
    matched ||= ifNoneMatch.slice(candidate.opaqueStart, candidate.opaqueEnd) === currentOpaqueTag;

    index = skipOptionalWhitespace(ifNoneMatch, candidate.end);
    if (index === ifNoneMatch.length) break;
    if (ifNoneMatch[index] !== ",") return false;
    index = skipOptionalWhitespace(ifNoneMatch, index + 1);
  }

  return sawTag && matched;
}

/** Test an If-Match field using Next.js's weak/strong-equivalent comparison. */
export function matchesIfMatch(ifMatch: string | undefined, etag: string | undefined): boolean {
  if (!ifMatch) return false;

  let index = skipOptionalWhitespace(ifMatch, 0);
  if (ifMatch[index] === "*") {
    return skipOptionalWhitespace(ifMatch, index + 1) === ifMatch.length;
  }

  if (!etag) return false;
  const current = parseEntityTag(etag, 0);
  if (!current || current.end !== etag.length) return false;
  const currentOpaqueTag = etag.slice(current.opaqueStart, current.opaqueEnd);

  let matched = false;
  let sawTag = false;
  while (index < ifMatch.length) {
    if (ifMatch[index] === ",") {
      index = skipOptionalWhitespace(ifMatch, index + 1);
      continue;
    }

    const candidate = parseEntityTag(ifMatch, index);
    if (!candidate) return false;
    sawTag = true;
    matched ||= ifMatch.slice(candidate.opaqueStart, candidate.opaqueEnd) === currentOpaqueTag;

    index = skipOptionalWhitespace(ifMatch, candidate.end);
    if (index === ifMatch.length) break;
    if (ifMatch[index] !== ",") return false;
    index = skipOptionalWhitespace(ifMatch, index + 1);
  }

  return sawTag && matched;
}

type ParsedEntityTag = {
  weak: boolean;
  opaqueStart: number;
  opaqueEnd: number;
  end: number;
};

function parseEntityTag(value: string, start: number): ParsedEntityTag | null {
  let index = start;
  const weak = value.startsWith("W/", index);
  if (weak) index += 2;
  if (value[index] !== '"') return null;

  const opaqueStart = ++index;
  while (index < value.length && value[index] !== '"') {
    const code = value.charCodeAt(index);
    // etagc = %x21 / %x23-7E / obs-text. A backslash is an ordinary
    // character here; entity tags do not use quoted-string escaping.
    const isEtagCharacter =
      code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
    if (!isEtagCharacter) return null;
    index++;
  }
  if (value[index] !== '"') return null;

  return { weak, opaqueStart, opaqueEnd: index, end: index + 1 };
}

function skipOptionalWhitespace(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") index++;
  return index;
}

type StaticConditionalHeaders = {
  cacheControl?: string | string[];
  ifMatch?: string | string[];
  ifUnmodifiedSince?: string | string[];
  ifNoneMatch?: string | string[];
  ifModifiedSince?: string | string[];
};

export type StaticPreconditionResult = "proceed" | "not-modified" | "precondition-failed";

/** Evaluate static representation preconditions in RFC 9110 section 13.2.2 order. */
export function evaluateStaticPreconditions(
  headers: StaticConditionalHeaders,
  method: string | undefined,
  etag: string | undefined,
  mtimeMs: number,
): StaticPreconditionResult {
  const ifMatch = joinHeader(headers.ifMatch);
  if (ifMatch !== undefined) {
    if (!matchesIfMatch(ifMatch, etag)) return "precondition-failed";
  } else {
    const ifUnmodifiedSince = joinHeader(headers.ifUnmodifiedSince);
    if (ifUnmodifiedSince) {
      const unmodifiedSinceMs = parseHttpDate(ifUnmodifiedSince);
      if (
        Number.isFinite(unmodifiedSinceMs) &&
        Number.isFinite(mtimeMs) &&
        Math.floor(mtimeMs / 1000) > Math.floor(unmodifiedSinceMs / 1000)
      ) {
        return "precondition-failed";
      }
    }
  }

  const ifNoneMatch = joinHeader(headers.ifNoneMatch);
  if (ifNoneMatch !== undefined) {
    const matches =
      ifNoneMatch.trim() === "*" || (etag !== undefined && matchesIfNoneMatch(ifNoneMatch, etag));
    if (!matches) return "proceed";
    if (method !== "GET" && method !== "HEAD") return "precondition-failed";

    const cacheControl = joinHeader(headers.cacheControl);
    return cacheControl && /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(cacheControl)
      ? "proceed"
      : "not-modified";
  }

  if (method !== "GET" && method !== "HEAD") return "proceed";

  const cacheControl = joinHeader(headers.cacheControl);
  if (cacheControl && /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(cacheControl)) return "proceed";

  const ifModifiedSince = joinHeader(headers.ifModifiedSince);
  if (!ifModifiedSince) return "proceed";
  const modifiedSinceMs = parseHttpDate(ifModifiedSince);
  if (!Number.isFinite(modifiedSinceMs)) return "proceed";
  return Number.isFinite(mtimeMs) &&
    Math.floor(mtimeMs / 1000) <= Math.floor(modifiedSinceMs / 1000)
    ? "not-modified"
    : "proceed";
}

function joinHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}
