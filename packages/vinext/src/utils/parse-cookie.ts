export type ParsedCookies = Record<string, string>;

type DecodedCookieValue = { ok: true; value: string } | { ok: false };

function decodeCookieValue(value: string): DecodedCookieValue {
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false };
  }
}

function forEachCookieHeaderPart(
  cookieHeader: string,
  visit: (part: string, separator: number) => void,
): void {
  for (const part of cookieHeader.split(/; */)) {
    if (!part) continue;
    visit(part, part.indexOf("="));
  }
}

/**
 * Parse a Cookie header using the semantics of Next.js's compiled `cookie`
 * package.
 */
export function parseCookieHeader(cookieHeader: string | null | undefined): ParsedCookies {
  const cookies: ParsedCookies = {};
  if (!cookieHeader) return cookies;

  forEachCookieHeaderPart(cookieHeader, (part, separator) => {
    if (separator < 0) return;

    const key = part.slice(0, separator).trim();
    let value = part.slice(separator + 1).trim();
    if (cookies[key] !== undefined) return;

    if (value.startsWith('"')) {
      value = value.slice(1, -1);
    }

    const decoded = decodeCookieValue(value);
    cookies[key] = decoded.ok ? decoded.value : value;
  });

  return cookies;
}

/**
 * Parse a Cookie header using Next.js/@edge-runtime RequestCookies semantics.
 */
export function parseEdgeRequestCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();

  forEachCookieHeaderPart(cookieHeader, (part, separator) => {
    if (separator === -1) {
      cookies.set(part, "true");
      return;
    }

    const decoded = decodeCookieValue(part.slice(separator + 1));
    if (decoded.ok) {
      cookies.set(part.slice(0, separator), decoded.value);
    }
  });

  return cookies;
}
