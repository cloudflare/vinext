// A side effect that runs whenever this module is loaded.
globalThis.__fakeToastUnusedLoaded = true;

export function ToastUnused() {
  return null;
}
