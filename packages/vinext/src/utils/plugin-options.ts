export async function flattenPluginOptions(value: unknown): Promise<unknown[]> {
  if (value instanceof Promise) {
    return flattenPluginOptions(await value);
  }
  if (Array.isArray(value)) {
    return (await Promise.all(value.map((item) => flattenPluginOptions(item)))).flat();
  }
  return value ? [value] : [];
}

export async function selectHybridPagesUserPlugins(
  value: unknown,
): Promise<import("vite").Plugin[]> {
  const flattened = await flattenPluginOptions(value);
  return flattened.filter(
    (plugin): plugin is import("vite").Plugin =>
      !!plugin &&
      typeof plugin === "object" &&
      "name" in plugin &&
      typeof plugin.name === "string" &&
      !plugin.name.startsWith("vinext:") &&
      !plugin.name.startsWith("vite:react") &&
      !plugin.name.startsWith("rsc:") &&
      plugin.name !== "vite-rsc-load-module-dev-proxy" &&
      !plugin.name.startsWith("vite-plugin-cloudflare"),
  );
}
