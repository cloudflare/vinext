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

type ParsedEntityTag = {
  opaqueStart: number;
  opaqueEnd: number;
  end: number;
};

function parseEntityTag(value: string, start: number): ParsedEntityTag | null {
  let index = start;
  if (value.startsWith("W/", index)) index += 2;
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

  return { opaqueStart, opaqueEnd: index, end: index + 1 };
}

function skipOptionalWhitespace(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") index++;
  return index;
}
