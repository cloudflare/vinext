// A side effect the bundler keeps whenever this module is imported.
globalThis.__fakeExportOrderUnusedLoaded = true;

export function OrderUnused() {
  return null;
}
