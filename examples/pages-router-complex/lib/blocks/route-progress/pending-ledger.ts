/**
 * Keyed pending-work ledger backing the route-progress overlay. Anything can
 * register a pending key (route transitions do it automatically); the
 * overlay shows while any key is held.
 */

type LedgerListener = () => void;

const heldKeys = new Set<string>();
const listeners = new Set<LedgerListener>();

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

export const holdPending = (key: string): void => {
  heldKeys.add(key);
  notify();
};

export const releasePending = (key: string): void => {
  heldKeys.delete(key);
  notify();
};

export const hasPending = (): boolean => heldKeys.size > 0;

export const subscribePending = (listener: LedgerListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
