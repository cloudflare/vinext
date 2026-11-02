import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { encodeCacheTag } from "../utils/encode-cache-tag.js";

/**
 * Build the edge path tag for a Pages ISR pathname.
 *
 * Every spelling of one pathname shares a single ISR entry, because
 * `pagesIsrCacheKey()` decodes each segment first. The tag must use that same
 * decoded identity. Otherwise `/users/%40alice` is stored at the edge under its
 * own tag, and `res.revalidate("/users/@alice")` or
 * `revalidatePath("/users/@alice")` never purges it.
 */
export function pagesPathCacheTag(isrPathname: string): string {
  const pathname = normalizePathnameForRouteMatch(isrPathname);
  const stem = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return encodeCacheTag(`_N_T_${stem || "/"}`);
}
