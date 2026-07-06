export async function flattenPluginOptions(value: unknown): Promise<unknown[]> {
  if (value instanceof Promise) {
    return flattenPluginOptions(await value);
  }
  if (Array.isArray(value)) {
    return (await Promise.all(value.map((item) => flattenPluginOptions(item)))).flat();
  }
  return value ? [value] : [];
}
