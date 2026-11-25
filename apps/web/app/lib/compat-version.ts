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
 * Next.js refs accepted on the wire. The workflow uses the ref in artifact
 * names, so it already only produces these characters.
 */
const NEXT_REF_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidNextRef(value: unknown): value is string {
  return typeof value === "string" && NEXT_REF_PATTERN.test(value);
}

/** The version a `?version=` value selects, defaulting to the public one. */
export function resolveNextRef(value: string | null | undefined): string {
  const ref = value?.trim();
  return ref || PUBLIC_NEXT_REF;
}
