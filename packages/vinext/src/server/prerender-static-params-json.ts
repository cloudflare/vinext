/**
 * JSON for the prerender discovery endpoints' generateStaticParams and
 * getStaticPaths results.
 *
 * `JSON.stringify` drops a property whose value is `undefined`, but Next.js
 * tells a present `undefined` param from a missing one: an optional catch-all
 * set to `undefined` (like `null` or `false`) is the route's root path, while
 * a missing key is an incomplete param set (build/static-paths/app.ts and
 * pages.ts validateParams check `params.hasOwnProperty(key)`). A present
 * `undefined` is sent as `null`, which the build reads the same way.
 */

function withPresentUndefinedAsNull(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const entries = Object.entries(params);
  if (!entries.some(([, value]) => value === undefined)) return params;
  return Object.fromEntries(
    entries.map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

/** A generateStaticParams result: an array of param objects. */
export function staticParamsForJson(result: unknown): unknown {
  return Array.isArray(result)
    ? result.map((params) => withPresentUndefinedAsNull(params))
    : result;
}

/** A getStaticPaths result: `{ paths: Array<string | { params, locale? }> }`. */
export function staticPathsForJson(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const { paths } = result as { paths?: unknown };
  if (!Array.isArray(paths)) return result;
  return {
    ...result,
    paths: paths.map((entry: unknown) =>
      entry && typeof entry === "object" && !Array.isArray(entry) && "params" in entry
        ? { ...entry, params: withPresentUndefinedAsNull(entry.params) }
        : entry,
    ),
  };
}
