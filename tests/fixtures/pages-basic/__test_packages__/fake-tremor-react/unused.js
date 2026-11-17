// A side effect that runs whenever this module is loaded.
globalThis.__fakeTremorUnusedLoaded = true;

export function DefaultUnused() {
  return null;
}
