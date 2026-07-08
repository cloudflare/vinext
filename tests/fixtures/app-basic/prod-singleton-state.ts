/**
 * Module-level singleton probe for the production-server double-evaluation
 * regression test.
 *
 * Unlike instrumentation-state.ts (which deliberately stores its state on
 * globalThis to survive multiple module instances), this module keeps its
 * state at MODULE level on purpose: real apps hold db pools, repository
 * registries, and config caches in module scope, and that only works when
 * the production server evaluates the server bundle exactly once. If the
 * server ends up with two copies of the bundle, the copy serving route
 * handlers reads `initializedBy: null` here even though boot-time
 * initialization ran.
 *
 * The probe is only meaningful for a freshly built output path (the first
 * build a process imports). After a rebuild to the SAME output path, the
 * prod server intentionally cache-busts the entry while bare chunk imports
 * still resolve to the first build (see resolveServerEntryImportUrl in
 * prod-server.ts), so this module would report `initializedBy: null` by
 * design. Tests using this probe must build into a fresh directory, as the
 * entry-module-identity regression test does.
 */

/** Module-level singleton state — intentionally NOT stored on globalThis. */
export const prodSingleton: { initializedBy: string | null } = { initializedBy: null };

/**
 * Called from instrumentation.ts register(), which the production server
 * invokes once on the module instance it imported at boot. A duplicate
 * instance of the server bundle never sees this write.
 */
export function initializeProdSingleton(source: string): void {
  if (prodSingleton.initializedBy === null) {
    prodSingleton.initializedBy = source;
  }
}

export function getProdSingletonSnapshot(): { initializedBy: string | null } {
  return { initializedBy: prodSingleton.initializedBy };
}
