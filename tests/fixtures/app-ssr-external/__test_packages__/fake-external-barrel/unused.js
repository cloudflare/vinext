// A side effect that runs whenever this module is loaded.
globalThis.__fakeExternalUnusedLoaded = true;

export function ExternalUnused() {
  return null;
}
