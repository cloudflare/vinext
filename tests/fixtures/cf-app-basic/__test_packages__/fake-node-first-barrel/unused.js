// A side effect the bundler keeps whenever this module is imported.
globalThis.__fakeNodeFirstUnusedLoaded = true;

export function NodeFirstUnused() {
  return null;
}
