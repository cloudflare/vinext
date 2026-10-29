// Records effect lifecycle events on `window` so the e2e spec can assert exactly
// which effects ran while routes move in and out of hidden BFCache Activity
// entries. Instance numbers count mounts per probe name, so a remount shows up
// as a new `#n` suffix instead of being inferred from reset state.
type EffectLogState = {
  log: string[];
  open: string[];
  mounts: Record<string, number>;
};

declare global {
  interface Window {
    __bfcacheEffects?: EffectLogState;
  }
}

function getState(): EffectLogState {
  window.__bfcacheEffects ??= { log: [], open: [], mounts: {} };
  return window.__bfcacheEffects;
}

// Only call this from an effect, so discarded renders never count as mounts.
export function recordMount(name: string): number {
  const state = getState();
  const instance = (state.mounts[name] ?? 0) + 1;
  state.mounts[name] = instance;
  state.log.push(`mount ${name}#${instance}`);
  return instance;
}

export function openConnection(key: string): () => void {
  const state = getState();
  state.log.push(`setup ${key}`);
  state.open.push(key);
  return () => {
    state.log.push(`cleanup ${key}`);
    state.open = state.open.filter((openKey) => openKey !== key);
  };
}
