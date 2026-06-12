export type ParsedCookies = Record<string, string>;

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse a Cookie header using the semantics of Next.js's compiled `cookie`
 * package while returning a dictionary without inherited properties.
 */
export function parseCookieHeader(cookieHeader: string | null | undefined): ParsedCookies {
  const cookies = Object.create(null) as ParsedCookies;
  if (!cookieHeader) return cookies;

  for (const part of cookieHeader.split(/; */)) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;

    const key = part.slice(0, separator).trim();
    let value = part.slice(separator + 1).trim();
    if (!key || Object.hasOwn(cookies, key)) continue;

    if (value.startsWith('"')) {
      value = value.slice(1, -1);
    }

    cookies[key] = decodeCookieValue(value);
  }

  return cookies;
}
