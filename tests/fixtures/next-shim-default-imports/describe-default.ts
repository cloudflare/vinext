// Records whether a `next/*` default import exposes the entry's API, as the
// CommonJS `module.exports` default of Next.js' own entrypoints does. Those
// objects have no `default` key of their own.
export function describeDefault(defaultBinding: unknown, marker: string): string {
  if (defaultBinding == null) return "missing";
  const shape = typeof (defaultBinding as Record<string, unknown>)[marker];
  return "default" in (defaultBinding as object) ? `${shape} with default` : shape;
}
