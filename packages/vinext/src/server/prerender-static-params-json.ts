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
 * sent as an envelope object. Every other object value, which no valid param
 * has, is wrapped in one too, so decoding never mistakes a user value for an
 * envelope.
 */

const ENVELOPE_KEY = "__vinextParam";

type ParamEnvelope = { [ENVELOPE_KEY]: "undefined" } | { [ENVELOPE_KEY]: "value"; value: unknown };

function isObjectValue(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeValue(value: unknown): unknown {
  if (value === undefined) return { [ENVELOPE_KEY]: "undefined" } satisfies ParamEnvelope;
  if (isObjectValue(value)) return { [ENVELOPE_KEY]: "value", value } satisfies ParamEnvelope;
  return value;
}

function decodeValue(value: unknown): unknown {
  if (!isObjectValue(value) || !(ENVELOPE_KEY in value)) return value;
  const envelope = value as ParamEnvelope;
  if (envelope[ENVELOPE_KEY] === "undefined") return undefined;
  // A wrapped value JSON dropped (a `toJSON` returning undefined) stays an
  // invalid object rather than reading as an undefined param.
  return Object.hasOwn(envelope, "value") ? Reflect.get(envelope, "value") : envelope;
}

function mapParamValues(params: unknown, map: (value: unknown) => unknown): unknown {
  if (!isObjectValue(params)) return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, map(value)]));
}

function mapStaticPaths(result: unknown, map: (value: unknown) => unknown): unknown {
  if (!isObjectValue(result)) return result;
  const { paths } = result as { paths?: unknown };
  if (!Array.isArray(paths)) return result;
  return {
    ...result,
    paths: paths.map((entry: unknown) =>
      isObjectValue(entry) && "params" in entry
        ? { ...entry, params: mapParamValues(entry.params, map) }
        : entry,
    ),
  };
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
