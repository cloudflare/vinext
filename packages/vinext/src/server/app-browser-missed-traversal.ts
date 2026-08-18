import { readHistoryStateTraversalIndex } from "./app-history-state.js";

/** The only Navigation API surface this check reads: activation/current entry keys. */
export type NavigationEntryKeySource = {
  activation?: { entry?: { key?: string } | null } | null;
  currentEntry?: { key?: string } | null;
};

/**
 * Reads `window.navigation`. Undefined outside Chromium, where the check no-ops
 * and a traversal missed before hydration stays unhandled.
 */
export function readBrowserNavigationEntryKeySource(): NavigationEntryKeySource | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { navigation?: NavigationEntryKeySource }).navigation;
}

/**
 * True when Back/Forward landed before the App Router's popstate listener
 * existed. The activation entry is fixed for the document's lifetime and entry
 * keys survive `replaceState`, so a key mismatch means a traversal fired with
 * nobody listening.
 *
 * Only an entry the App Router owns can be replayed. A traversal index alone
 * does not prove ownership: vinext's patched `history.pushState` copies that
 * metadata onto entries raw callers create, so any external history write in
 * this document disqualifies the check and the traversal is left unhandled.
 */
export function hasMissedInitialTraversal(options: {
  externalHistoryWriteObserved: boolean;
  historyState: unknown;
  navigation: NavigationEntryKeySource | undefined;
}): boolean {
  if (options.externalHistoryWriteObserved) return false;
  const activationKey = options.navigation?.activation?.entry?.key;
  const currentKey = options.navigation?.currentEntry?.key;
  if (typeof activationKey !== "string" || typeof currentKey !== "string") return false;
  if (activationKey === currentKey) return false;
  return readHistoryStateTraversalIndex(options.historyState) !== null;
}
