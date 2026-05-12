export type AppBrowserServerActionResult<TRoot> = {
  root?: TRoot;
  returnValue?: {
    ok: boolean;
    data: unknown;
  };
};

/**
 * Structural discriminator: matches on `"returnValue"` or `"root"` keys.
 * This is safe because {@link AppWireElements} keys are prefixed (`route:`,
 * `slot:`, `__route`, etc.) and will never collide with these property names.
 * If the wire format ever adds a `"root"` key, this guard must be updated.
 */
export function isServerActionResult<TRoot>(
  value: unknown,
): value is AppBrowserServerActionResult<TRoot> {
  return !!value && typeof value === "object" && ("returnValue" in value || "root" in value);
}

export function shouldClearClientNavigationCachesForServerActionResult<TRoot>(
  result: AppBrowserServerActionResult<TRoot> | TRoot,
): boolean {
  if (!isServerActionResult<TRoot>(result)) {
    return true;
  }

  return result.root !== undefined;
}
