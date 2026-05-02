// Module-level store for the dev error overlay. Lives in its own file so the
// overlay React component (dev-error-overlay.tsx) can subscribe via
// useSyncExternalStore without circular imports.

export type Source = "uncaught" | "caught" | "window-error" | "unhandledrejection";

export type ReportedError = {
  source: Source;
  message: string;
  stack: string | undefined;
  componentStack: string | undefined;
};

export type OverlayState = {
  errors: ReportedError[];
  index: number;
  minimized: boolean;
};

// Cap the buffer so a hot-reloading loop or an effect that throws on every
// render can't grow the array (and its retained stack strings) without
// bound. FIFO eviction keeps the most recent failures.
const MAX_DEV_OVERLAY_ERRORS = 50;

let snapshot: OverlayState = { errors: [], index: 0, minimized: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeOverlay(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getOverlaySnapshot(): OverlayState {
  return snapshot;
}

export function reportToOverlay(error: ReportedError): void {
  // Any new error pops the dialog open, regardless of source or current
  // state. The developer can minimize once they've taken stock; subsequent
  // failures will re-expand.
  const next = [...snapshot.errors, error];
  const dropped = next.length > MAX_DEV_OVERLAY_ERRORS ? next.length - MAX_DEV_OVERLAY_ERRORS : 0;
  const errors = dropped > 0 ? next.slice(dropped) : next;
  snapshot = {
    errors,
    index: errors.length - 1,
    minimized: false,
  };
  emit();
}

export function dismissOverlay(): void {
  snapshot = { errors: [], index: 0, minimized: false };
  emit();
}

export function setOverlayIndex(index: number): void {
  if (index < 0 || index >= snapshot.errors.length) return;
  snapshot = { ...snapshot, index };
  emit();
}

export function minimizeOverlay(): void {
  if (snapshot.minimized) return;
  snapshot = { ...snapshot, minimized: true };
  emit();
}

export function expandOverlay(): void {
  if (!snapshot.minimized) return;
  snapshot = { ...snapshot, minimized: false };
  emit();
}
