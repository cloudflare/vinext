import { normalizePathnameForRouteMatch } from "../routing/utils.js";

/**
 * Key a public file by the normalized pathname a request for it matches with.
 *
 * Request pathnames are decoded once per segment with path delimiters kept
 * encoded, so `public/a b.txt` is `/a b.txt` and `public/C#.txt` is
 * `/C%23.txt`. Keying only this form keeps a double-encoded alias such as
 * `/a%2520b.txt`, which middleware matchers see as `/a%20b.txt`, from
 * reaching `public/a b.txt`.
 */
export function publicFileRouteKey(pathname: string): string {
  return normalizePathnameForRouteMatch(
    pathname
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/"),
  );
}
