/**
 * JSON for the prerender discovery endpoints' generateStaticParams and
 * getStaticPaths results.
 *
 * `JSON.stringify` drops a property whose value is `undefined`, but Next.js
 * tells a present `undefined` param from a missing one: an optional catch-all
 * set to `undefined` is the route's root path, a required param set to
 * `undefined` fails with "received undefined", and a missing key is an
 * incomplete param set (build/static-paths/app.ts and pages.ts validateParams
 * check `params.hasOwnProperty(key)`). A present `undefined` is sent as a
 * marker object, which the build turns back into `undefined`.
 */

const UNDEFINED_PARAM_KEY = "__vinextUndefinedParam";

function isUndefinedParamMarker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === UNDEFINED_PARAM_KEY;
}

function mapParamValues(params: unknown, map: (value: unknown) => unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, map(value)]));
}

function mapStaticParams(result: unknown, map: (value: unknown) => unknown): unknown {
  return Array.isArray(result) ? result.map((params) => mapParamValues(params, map)) : result;
}

function mapStaticPaths(result: unknown, map: (value: unknown) => unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const { paths } = result as { paths?: unknown };
  if (!Array.isArray(paths)) return result;
  return {
    ...result,
    paths: paths.map((entry: unknown) =>
      entry && typeof entry === "object" && !Array.isArray(entry) && "params" in entry
        ? { ...entry, params: mapParamValues(entry.params, map) }
        : entry,
    ),
  };
}

const encodeValue = (value: unknown): unknown =>
  value === undefined ? { [UNDEFINED_PARAM_KEY]: true } : value;
const decodeValue = (value: unknown): unknown =>
  isUndefinedParamMarker(value) ? undefined : value;

/** A generateStaticParams result (an array of param objects) ready for JSON. */
export function staticParamsToJson(result: unknown): unknown {
  return mapStaticParams(result, encodeValue);
}

/** A generateStaticParams result read back from {@link staticParamsToJson}. */
export function staticParamsFromJson(value: unknown): unknown {
  return mapStaticParams(value, decodeValue);
}

/** A getStaticPaths result (`{ paths: Array<string | { params, locale? }> }`) ready for JSON. */
export function staticPathsToJson(result: unknown): unknown {
  return mapStaticPaths(result, encodeValue);
}

/** A getStaticPaths result read back from {@link staticPathsToJson}. */
export function staticPathsFromJson(value: unknown): unknown {
  return mapStaticPaths(value, decodeValue);
}
