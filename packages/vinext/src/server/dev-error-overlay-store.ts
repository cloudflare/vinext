// Module-level store for the dev error overlay. Lives in its own file so the
// overlay React component (dev-error-overlay.tsx) can subscribe via
// useSyncExternalStore without circular imports.

export type Source =
  | "server"
  | "vite"
  | "uncaught"
  | "caught"
  | "window-error"
  | "unhandledrejection";

export type ReportedError = {
  id: number;
  source: Source;
  message: string;
  stack: string | undefined;
  ignoredStackFrames: boolean[] | undefined;
  projectRoot: string | undefined;
  codeFrame: OverlayCodeFrame | undefined;
  componentStack: string | undefined;
};

export type OverlayCodeFrame = {
  file: string;
  line: number;
  column: number;
  methodName?: string;
  lines: OverlayCodeFrameLine[];
};

type OverlayCodeFrameLine = {
  line: number;
  text: string;
  isErrorLine: boolean;
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
let nextErrorId = 1;

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

export function reportToOverlay(error: Omit<ReportedError, "id">): number {
  // Any new error pops the dialog open, regardless of source or current
  // state. The developer can minimize once they've taken stock; subsequent
  // failures will re-expand.
  const id = nextErrorId++;
  const next = [...snapshot.errors, { ...error, id }];
  const dropped = next.length > MAX_DEV_OVERLAY_ERRORS ? next.length - MAX_DEV_OVERLAY_ERRORS : 0;
  const errors = dropped > 0 ? next.slice(dropped) : next;
  snapshot = {
    errors,
    index: errors.length - 1,
    minimized: false,
  };
  emit();
  return id;
}

export function updateOverlayErrorStack(
  id: number,
  stack: string | undefined,
  ignoredStackFrames?: boolean[],
  codeFrame?: OverlayCodeFrame,
  projectRoot?: string,
): void {
  if (!snapshot.errors.some((error) => error.id === id)) return;
  snapshot = {
    ...snapshot,
    errors: snapshot.errors.map((error) =>
      error.id === id ? { ...error, stack, ignoredStackFrames, codeFrame, projectRoot } : error,
    ),
  };
  emit();
}

export function dismissOverlay(): void {
  if (snapshot.errors.length === 0 && snapshot.index === 0 && !snapshot.minimized) return;
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
