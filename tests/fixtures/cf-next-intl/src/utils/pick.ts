// vinext: stands in for `lodash/pick` so the fixture doesn't add lodash as a
// dependency. Only the subset the playground uses is implemented.
export default function pick<T extends Record<string, unknown>>(
  object: T,
  keys: string | Array<string>
): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (key in object) result[key] = object[key];
  }
  return result as Partial<T>;
}
