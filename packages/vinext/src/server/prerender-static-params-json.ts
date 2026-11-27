/**
 * JSON for the param objects the prerender discovery endpoints exchange:
 * generateStaticParams results, getStaticPaths results and parent params.
 *
 * `JSON.stringify` drops a property whose value is `undefined`, but Next.js
 * tells a present `undefined` param from a missing one: an optional catch-all
 * set to `undefined` is the route's root path, a required param set to
 * `undefined` fails with "received undefined", a missing key is an
 * incomplete param set (build/static-paths/app.ts and pages.ts validateParams
 * check `params.hasOwnProperty(key)`), and a layout's `undefined` reaches the
 * child generateStaticParams as an own property. A present `undefined` is
 * sent as a marker. An object value, which no valid param has, is sent as
 * another marker that reads back as an empty object: still invalid, without
 * running the user object's `toJSON` or carrying it through JSON. Every
 * property is read once, as `JSON.stringify` does.
 */

const MARKER_KEY = "__vinextParam";

type ParamMarker = { [MARKER_KEY]: "undefined" | "object" };

function isObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeValue(value: unknown): unknown {
  if (value === undefined) return { [MARKER_KEY]: "undefined" } satisfies ParamMarker;
  if (isObjectValue(value)) return { [MARKER_KEY]: "object" } satisfies ParamMarker;
  return value;
}

function decodeValue(value: unknown): unknown {
  if (!isObjectValue(value)) return value;
  return Reflect.get(value, MARKER_KEY) === "undefined" ? undefined : {};
}

function mapParamValues(params: unknown, map: (value: unknown) => unknown): unknown {
  if (!isObjectValue(params)) return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, map(value)]));
}

function mapStaticPaths(result: unknown, map: (value: unknown) => unknown): unknown {
  if (!isObjectValue(result)) return result;
  return Object.fromEntries(
    Object.entries(result).map(([key, paths]) => [
      key,
      key === "paths" && Array.isArray(paths)
        ? paths.map((entry: unknown) =>
            isObjectValue(entry)
              ? Object.fromEntries(
                  Object.entries(entry).map(([entryKey, value]) => [
                    entryKey,
                    entryKey === "params" ? mapParamValues(value, map) : value,
                  ]),
                )
              : entry,
          )
        : paths,
    ]),
  );
}

/** One param object ready for JSON. */
export function paramsToJson(params: unknown): unknown {
  return mapParamValues(params, encodeValue);
}

/** One param object read back from {@link paramsToJson}. */
export function paramsFromJson(value: unknown): unknown {
  return mapParamValues(value, decodeValue);
}

/** A generateStaticParams result (an array of param objects) ready for JSON. */
export function staticParamsToJson(result: unknown): unknown {
  return Array.isArray(result) ? result.map(paramsToJson) : result;
}

/** A generateStaticParams result read back from {@link staticParamsToJson}. */
export function staticParamsFromJson(value: unknown): unknown {
  return Array.isArray(value) ? value.map(paramsFromJson) : value;
}

/** A getStaticPaths result (`{ paths: Array<string | { params, locale? }> }`) ready for JSON. */
export function staticPathsToJson(result: unknown): unknown {
  return mapStaticPaths(result, encodeValue);
}

/** A getStaticPaths result read back from {@link staticPathsToJson}. */
export function staticPathsFromJson(value: unknown): unknown {
  return mapStaticPaths(value, decodeValue);
}
