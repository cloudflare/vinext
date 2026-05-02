// Dev-only runtime error overlay. Surfaces three error sources that
// otherwise only reach the console:
//   1. React render errors caught by an error.tsx boundary (onCaughtError)
//   2. React render errors with no boundary above them (onUncaughtError)
//   3. Plain script errors / unhandled promise rejections (window listeners)
//
// Rendered via a separate React root mounted on a detached <div> appended to
// the body. That isolation means the overlay survives an unmount of the main
// hydrateRoot(document, ...) tree — necessary because most of the errors we
// want to surface are exactly the ones that take that tree down.

import { useEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  type OverlayState,
  type ReportedError,
  type Source,
  dismissOverlay,
  expandOverlay,
  getOverlaySnapshot,
  minimizeOverlay,
  reportToOverlay,
  setOverlayIndex,
  subscribeOverlay,
} from "./dev-error-overlay-store.js";

// Re-export so callers (e.g. the HMR rsc:update handler) can clear the
// overlay when a new payload lands.
export { dismissOverlay } from "./dev-error-overlay-store.js";

const MOUNT_NODE_ID = "__vinext_dev_error_overlay_root";

let reactRoot: Root | null = null;
let installed = false;

// Errors React already routed through onCaughtError/onUncaughtError shouldn't
// also surface from the window listeners — otherwise the same throw appears
// twice in the dialog ("Runtime Error" + "Unhandled Script Error"). We track
// instances we've reported and skip them in the global handlers.
const reportedErrors = new WeakSet<object>();

function rememberReported(error: unknown): void {
  if (error && typeof error === "object") reportedErrors.add(error);
}

function alreadyReported(error: unknown): boolean {
  return !!error && typeof error === "object" && reportedErrors.has(error);
}

export function installDevErrorOverlay(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error;
    if (err instanceof Error) {
      if (alreadyReported(err)) return;
      reportDevError(err, { source: "window-error" });
    } else if (event.message) {
      reportDevError(new Error(event.message), { source: "window-error" });
    }
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    if (reason instanceof Error) {
      if (alreadyReported(reason)) return;
      reportDevError(reason, { source: "unhandledrejection" });
    } else {
      reportDevError(new Error(String(reason)), { source: "unhandledrejection" });
    }
  });
}

function reportDevError(
  error: unknown,
  options: { source: Source; componentStack?: string },
): void {
  if (typeof window === "undefined") return;

  rememberReported(error);

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : safeStringify(error);
  const stack = error instanceof Error ? error.stack : undefined;

  ensureMounted();
  reportToOverlay({
    source: options.source,
    message,
    stack,
    componentStack: options.componentStack,
  });
}

// React's onCaughtError fires for boundary-caught errors. We log to the console
// (preserving the default behavior) and surface in the overlay. Sentinel errors
// (NEXT_NOT_FOUND, NEXT_REDIRECT, etc.) are re-thrown in getDerivedStateFromError
// before they reach onCaughtError, so they don't appear here in practice.
export function devOnCaughtError(
  error: unknown,
  errorInfo: { componentStack?: string; errorBoundary?: unknown },
): void {
  console.error(error);
  if (errorInfo?.componentStack) {
    console.error("The above error occurred in a React component:\n" + errorInfo.componentStack);
  }
  reportDevError(error, { source: "caught", componentStack: errorInfo?.componentStack });
}

// Dev variant of onUncaughtError. Surfaces the error in the overlay and stops
// — we deliberately do NOT perform the prod recovery navigation
// (window.location.assign) because in dev the overlay is the user-facing
// recovery; a hard navigation would blow it away along with the rest of the
// page. HMR or a manual refresh resumes the session once the bug is fixed.
export function devOnUncaughtError(
  error: unknown,
  errorInfo: { componentStack?: string; errorBoundary?: unknown },
): void {
  console.error(error);
  if (errorInfo?.componentStack) {
    console.error("The above error occurred in a React component:\n" + errorInfo.componentStack);
  }
  reportDevError(error, { source: "uncaught", componentStack: errorInfo?.componentStack });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function ensureMounted(): void {
  if (reactRoot) return;
  const node = document.createElement("div");
  node.id = MOUNT_NODE_ID;
  // Fall back to documentElement in case body hasn't been parsed yet (e.g.
  // an extremely early hydration error firing before the body element is
  // attached). Either parent keeps the overlay outside the React-managed
  // hydrateRoot tree, which is what matters.
  (document.body ?? document.documentElement).appendChild(node);
  reactRoot = createRoot(node);
  reactRoot.render(<DevErrorOverlayApp />);
}

// ---------------------------------------------------------------------------
// React component tree
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<Source, string> = {
  uncaught: "Unhandled Runtime Error",
  caught: "Runtime Error",
  "window-error": "Unhandled Script Error",
  unhandledrejection: "Unhandled Promise Rejection",
};

function DevErrorOverlayApp(): React.ReactNode {
  const state = useSyncExternalStore<OverlayState>(
    subscribeOverlay,
    getOverlaySnapshot,
    getOverlaySnapshot,
  );
  if (state.errors.length === 0) return null;
  const current = state.errors[state.index] ?? state.errors[0]!;

  // Render the stylesheet once at the root so it's not re-injected when
  // toggling between minimized and expanded states.
  return (
    <>
      <style>{overlayStylesheet}</style>
      {state.minimized ? (
        <DevErrorIndicator
          count={state.errors.length}
          source={current.source}
          onExpand={expandOverlay}
        />
      ) : (
        <DevErrorOverlay
          error={current}
          index={state.index}
          total={state.errors.length}
          // setOverlayIndex bounds-checks internally and the prev/next
          // buttons are disabled at the edges, so no clamp needed here.
          onPrev={() => setOverlayIndex(state.index - 1)}
          onNext={() => setOverlayIndex(state.index + 1)}
          onMinimize={minimizeOverlay}
          onDismiss={dismissOverlay}
        />
      )}
    </>
  );
}

function DevErrorIndicator({
  count,
  source,
  onExpand,
}: {
  count: number;
  source: Source;
  onExpand: () => void;
}): React.ReactNode {
  return (
    <div style={indicatorContainerStyle}>
      <button
        type="button"
        data-testid="vinext-dev-error-indicator"
        aria-label={`${count} runtime error${count === 1 ? "" : "s"} — click to expand`}
        title={SOURCE_LABEL[source]}
        onClick={onExpand}
        className="vinext-overlay-indicator"
      >
        <span aria-hidden="true" style={indicatorIconStyle}>
          ⚠
        </span>
        <span data-testid="vinext-dev-error-indicator-count" style={indicatorCountStyle}>
          {count}
        </span>
      </button>
    </div>
  );
}

function DevErrorOverlay({
  error,
  index,
  total,
  onPrev,
  onNext,
  onMinimize,
  onDismiss,
}: {
  error: ReportedError;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onMinimize: () => void;
  onDismiss: () => void;
}): React.ReactNode {
  const frames = error.stack ? parseStack(error.stack) : [];

  // Esc minimizes, ←/→ navigate between errors. Esc no longer dismisses
  // outright — once a developer wants the overlay gone they can hit the ×
  // button. Listener is attached on the window so it works regardless of
  // focus location inside the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onMinimize();
      } else if (e.key === "ArrowLeft" && total > 1) {
        onPrev();
      } else if (e.key === "ArrowRight" && total > 1) {
        onNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onMinimize, onPrev, onNext, total]);

  return (
    <div style={backdropStyle} data-testid="vinext-dev-error-backdrop" onClick={onMinimize}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={SOURCE_LABEL[error.source]}
        data-testid="vinext-dev-error-overlay"
        style={dialogStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={accentBarStyle} />

        <header style={headerStyle}>
          <div style={headerLeftStyle}>
            <span data-testid="vinext-dev-error-title" style={badgeStyle}>
              {SOURCE_LABEL[error.source]}
            </span>
            {total > 1 ? (
              <div data-testid="vinext-dev-error-pagination" style={paginationStyle}>
                <button
                  type="button"
                  data-testid="vinext-dev-error-prev"
                  onClick={onPrev}
                  disabled={index === 0}
                  className="vinext-overlay-nav"
                  aria-label="Previous error"
                >
                  ‹
                </button>
                <span data-testid="vinext-dev-error-counter" style={counterStyle}>
                  {index + 1} of {total}
                </span>
                <button
                  type="button"
                  data-testid="vinext-dev-error-next"
                  onClick={onNext}
                  disabled={index === total - 1}
                  className="vinext-overlay-nav"
                  aria-label="Next error"
                >
                  ›
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="vinext-dev-error-minimize"
            onClick={onMinimize}
            className="vinext-overlay-minimize"
            aria-label="Minimize"
            title="Minimize (Esc)"
          >
            –
          </button>
          <button
            type="button"
            data-testid="vinext-dev-error-close"
            onClick={onDismiss}
            className="vinext-overlay-close"
            aria-label="Dismiss"
            title="Dismiss all errors"
          >
            ×
          </button>
        </header>

        <div style={bodyStyle}>
          <h2 data-testid="vinext-dev-error-message" style={messageStyle}>
            {error.message}
          </h2>

          {frames.length > 0 ? (
            <ol data-testid="vinext-dev-error-stack" style={stackListStyle}>
              {frames.map((frame) => (
                <li key={frame.key} className="vinext-overlay-frame" style={stackItemStyle}>
                  <span style={frameFnStyle}>{frame.fn}</span>
                  {frame.file ? (
                    <span style={frameLocStyle}>
                      {frame.file}
                      {frame.line ? `:${frame.line}` : ""}
                      {frame.col ? `:${frame.col}` : ""}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}

          {error.componentStack ? (
            <details style={detailsStyle}>
              <summary style={summaryStyle}>Component stack</summary>
              <pre data-testid="vinext-dev-error-component-stack" style={componentStackStyle}>
                {error.componentStack}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stack parsing — handles V8 ("    at fn (file:line:col)") and SpiderMonkey/
// JavaScriptCore ("fn@file:line:col") formats. Lines that don't match either
// shape are kept verbatim as a function-name-only frame so the overlay still
// renders something useful in unfamiliar runtimes.
// ---------------------------------------------------------------------------

type Frame = { key: string; fn: string; file?: string; line?: string; col?: string };

const V8_PAREN_FRAME = /^(.*?)\s*\((.+):(\d+):(\d+)\)$/;
const V8_BARE_FRAME = /^(.+):(\d+):(\d+)$/;
const MOZ_FRAME = /^(.*?)@(.+):(\d+):(\d+)$/;

function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  // Suffix repeat occurrences with #2, #3 so React keys stay unique even when
  // the same frame appears multiple times in a recursive stack.
  const seen = new Map<string, number>();
  const pushFrame = (fn: string, file?: string, line?: string, col?: string): void => {
    const base = `${fn}@${file ?? ""}:${line ?? ""}:${col ?? ""}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const key = count === 1 ? base : `${base}#${count}`;
    frames.push({ key, fn, file, line, col });
  };
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // V8 / Chromium: "    at fn (file:line:col)" or "    at file:line:col"
    if (line.startsWith("at ")) {
      const body = line.slice(3);
      const parenMatch = body.match(V8_PAREN_FRAME);
      if (parenMatch) {
        pushFrame(parenMatch[1] || "<anonymous>", parenMatch[2], parenMatch[3], parenMatch[4]);
        continue;
      }
      const bareMatch = body.match(V8_BARE_FRAME);
      if (bareMatch) {
        pushFrame("<anonymous>", bareMatch[1], bareMatch[2], bareMatch[3]);
        continue;
      }
      pushFrame(body);
      continue;
    }

    // SpiderMonkey (Firefox) / JavaScriptCore (Safari): "fn@file:line:col".
    // The first line of a Firefox stack is the error message itself; skip it
    // by requiring the @-form match.
    const mozMatch = line.match(MOZ_FRAME);
    if (mozMatch) {
      pushFrame(mozMatch[1] || "<anonymous>", mozMatch[2], mozMatch[3], mozMatch[4]);
      continue;
    }

    // Unknown shape — preserve the line as a function-name-only frame so the
    // overlay shows something rather than dropping the line silently.
    pushFrame(line);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Inline styles + a tiny stylesheet for hover/focus + entrance animation.
// Keeping it all in this file means the overlay has no external CSS
// dependency and works the same way in any host app.
// ---------------------------------------------------------------------------

const FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const overlayStylesheet = `
@keyframes vinextOverlayBackdropIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes vinextOverlayDialogIn {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes vinextOverlayIndicatorIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.vinext-overlay-nav {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 2px 8px;
  font-size: 14px;
  line-height: 1;
  border-radius: 6px;
  transition: background 0.12s ease;
}
.vinext-overlay-nav:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
}
.vinext-overlay-nav:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.vinext-overlay-minimize,
.vinext-overlay-close {
  background: transparent;
  border: none;
  color: #a1a1aa;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.12s ease, color 0.12s ease;
}
.vinext-overlay-minimize:hover,
.vinext-overlay-close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fafafa;
}
.vinext-overlay-close { font-size: 20px; }
.vinext-overlay-frame {
  padding: 8px 12px;
  border-radius: 6px;
  transition: background 0.12s ease;
}
.vinext-overlay-frame:hover {
  background: rgba(255, 255, 255, 0.04);
}
.vinext-overlay-indicator {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: #18181b;
  color: #fafafa;
  border: 1px solid rgba(239, 68, 68, 0.45);
  font: 600 13px ${FONT_STACK};
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
  animation: vinextOverlayIndicatorIn 0.18s ease-out;
}
.vinext-overlay-indicator:hover {
  background: #1f1f23;
  border-color: rgba(239, 68, 68, 0.7);
  transform: translateY(-1px);
}
`;

const backdropStyle: React.CSSProperties = {
  // The backdrop captures click-outside-to-minimize as a proper modal would —
  // a click on it dismisses the overlay rather than reaching the page
  // underneath. The dialog re-enables pointer events for itself via
  // dialogStyle.
  position: "fixed",
  inset: 0,
  background: "rgba(10, 10, 12, 0.55)",
  backdropFilter: "blur(3px)",
  WebkitBackdropFilter: "blur(3px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  zIndex: 2147483646,
  animation: "vinextOverlayBackdropIn 0.15s ease-out",
};

const dialogStyle: React.CSSProperties = {
  position: "relative",
  pointerEvents: "auto",
  width: "min(640px, 100%)",
  maxHeight: "min(80vh, 720px)",
  display: "flex",
  flexDirection: "column",
  background: "#0a0a0a",
  color: "#fafafa",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 12,
  fontFamily: FONT_STACK,
  fontSize: 14,
  lineHeight: 1.5,
  overflow: "hidden",
  animation: "vinextOverlayDialogIn 0.18s ease-out",
};

const indicatorContainerStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 16,
  left: 16,
  zIndex: 2147483646,
};

const indicatorIconStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#ef4444",
  fontSize: 14,
};

const indicatorCountStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 18,
  padding: "0 6px",
  height: 18,
  borderRadius: 999,
  background: "rgba(239, 68, 68, 0.18)",
  color: "#fca5a5",
  fontSize: 11,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};

const accentBarStyle: React.CSSProperties = {
  height: 3,
  background: "linear-gradient(90deg, #ef4444 0%, #f97316 100%)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 16px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
};

const headerLeftStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
};

const badgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "rgba(239, 68, 68, 0.12)",
  color: "#fca5a5",
  border: "1px solid rgba(239, 68, 68, 0.25)",
  padding: "3px 10px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.2,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

const paginationStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  color: "#a1a1aa",
  fontSize: 12,
};

const counterStyle: React.CSSProperties = {
  padding: "0 4px",
  fontVariantNumeric: "tabular-nums",
};

const bodyStyle: React.CSSProperties = {
  padding: "16px 20px 20px",
  overflow: "auto",
  flex: 1,
};

const messageStyle: React.CSSProperties = {
  margin: "0 0 16px 0",
  fontFamily: MONO_STACK,
  fontSize: 16,
  fontWeight: 500,
  lineHeight: 1.45,
  color: "#fafafa",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const stackListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontFamily: MONO_STACK,
  fontSize: 12,
};

const stackItemStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  cursor: "default",
};

const frameFnStyle: React.CSSProperties = {
  color: "#fafafa",
  fontWeight: 500,
};

const frameLocStyle: React.CSSProperties = {
  color: "#71717a",
  fontSize: 11,
};

const detailsStyle: React.CSSProperties = {
  marginTop: 16,
  paddingTop: 12,
  borderTop: "1px solid rgba(255, 255, 255, 0.06)",
  color: "#a1a1aa",
  fontSize: 12,
};

const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  userSelect: "none",
  padding: "4px 0",
  color: "#a1a1aa",
  fontWeight: 500,
};

const componentStackStyle: React.CSSProperties = {
  margin: "8px 0 0 0",
  fontFamily: MONO_STACK,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "#a1a1aa",
};
