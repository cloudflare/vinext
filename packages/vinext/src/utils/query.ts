/**
 * Add a query parameter value to an object, promoting to array for duplicate keys.
 * Matches Next.js behavior: ?a=1&a=2 → { a: ['1', '2'] }
 */
export function addQueryParam(
  obj: Record<string, string | string[]>,
  key: string,
  value: string,
): void {
  if (key in obj) {
    obj[key] = Array.isArray(obj[key])
      ? (obj[key] as string[]).concat(value)
      : [obj[key] as string, value];
  } else {
    obj[key] = value;
  }
}

/**
 * Parse a URL's query string into a Record, with multi-value keys promoted to arrays.
 */
export function parseQueryString(url: string): Record<string, string | string[]> {
  const qs = url.split("?")[1];
  if (!qs) return {};
  const params = new URLSearchParams(qs);
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    addQueryParam(query, key, value);
  }
  return query;
}
