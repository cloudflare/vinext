/**
 * Next.js versions on /compatibility.
 *
 * The deploy suite publishes one series of runs per Next.js version
 * (compat_runs.next_ref). The page and the failures API show the public
 * version below; any other stored version is only shown when `?version=`
 * names it.
 */
export const PUBLIC_NEXT_REF = "v16.2.6";

/**
 * Next.js refs accepted on the wire and by `?version=`. The /compatibility
 * rewrite in next.config.ts matches the same pattern. The workflow uses the
 * ref in artifact names, so it already only produces these characters.
 */
export const NEXT_REF_PATTERN_SOURCE = "[A-Za-z0-9._-]{1,64}";
const NEXT_REF_PATTERN = new RegExp(`^${NEXT_REF_PATTERN_SOURCE}$`);

export function isValidNextRef(value: unknown): value is string {
  return typeof value === "string" && NEXT_REF_PATTERN.test(value);
}

/**
 * The version `?version=` selects, matching the /compatibility rewrite: the
 * last `version` value wins (as in Next.js `has` matching), and anything
 * outside the pattern falls back to the public version.
 */
export function resolveNextRef(searchParams: URLSearchParams): string {
  const ref = searchParams.getAll("version").at(-1);
  return isValidNextRef(ref) ? ref : PUBLIC_NEXT_REF;
}
