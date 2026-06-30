// Dev-only runtime error overlay. Surfaces four error sources that
// otherwise only reach the console:
//   1. React render errors caught by an error.tsx boundary (onCaughtError)
//   2. React render errors with no boundary above them (onUncaughtError)
//   3. Plain script errors / unhandled promise rejections (window listeners)
//   4. Vite build/transform errors reported over HMR (vite:error)
//
// Rendered via a separate React root mounted on a detached <div> appended to
// the body. That isolation means the overlay survives an unmount of the main
// hydrateRoot(document, ...) tree — necessary because most of the errors we
// want to surface are exactly the ones that take that tree down.

import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

import { VINEXT_DEV_ERROR_RECOVERY_EVENT } from "../utils/dev-error-recovery-event.js";
import { isNavigationSignalError } from "../utils/navigation-signal.js";
import {
  type OverlayState,
  type OverlayCodeFrame,
  type ReportedError,
  type Source,
  dismissOverlay,
  expandOverlay,
  getOverlaySnapshot,
  minimizeOverlay,
  reportToOverlay,
  setOverlayIndex,
  subscribeOverlay,
  updateOverlayErrorStack,
} from "./dev-error-overlay-store.js";
import { VINEXT_ORIGINAL_STACK_TRACE_ENDPOINT } from "../utils/dev-stack-sourcemap-endpoint.js";

// Re-export so callers (e.g. the HMR rsc:update handler) can clear the
// overlay when a new payload lands.
export { dismissOverlay } from "./dev-error-overlay-store.js";

export const DEV_ERROR_OVERLAY_HOST_ID = "__vinext_dev_error_overlay_root";
export const DEV_ERROR_OVERLAY_MOUNT_ID = "__vinext_dev_error_overlay_mount";
const VITE_ERROR_HANDLER_DATA_KEY = "__vinext_vite_error_handler__";
const REACT_REFRESH_RECOVERY_RETRY_DELAY_MS = 16;

let reactRoot: Root | null = null;
let installed = false;

type ReactRefreshWindow = Window &
  typeof globalThis & {
    __registerBeforePerformReactRefresh?: (cb: () => void | Promise<void>) => void;
    __vinextReactRefreshErrorRecoveryInstalled?: boolean;
    __vinextReactRefreshErrorRecoveryInstallScheduled?: boolean;
  };

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
  if (typeof window === "undefined") return;

  installReactRefreshErrorRecovery();

  if (installed) return;
  installed = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    const err = event.error;
    if (isNavigationSignalError(err)) return;
    if (err instanceof Error) {
      if (alreadyReported(err)) return;
      reportDevError(err, { source: "window-error" });
    } else if (event.message) {
      reportDevError(new Error(event.message), { source: "window-error" });
    }
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    if (isNavigationSignalError(reason)) return;
    if (reason instanceof Error) {
      if (alreadyReported(reason)) return;
      reportDevError(reason, { source: "unhandledrejection" });
    } else {
      reportDevError(new Error(String(reason)), { source: "unhandledrejection" });
    }
  });
}

export function installReactRefreshErrorRecovery(): void {
  if (typeof window === "undefined") return;
  if (tryInstallReactRefreshErrorRecovery()) return;

  const refreshWindow = window as ReactRefreshWindow;
  if (refreshWindow.__vinextReactRefreshErrorRecoveryInstallScheduled) return;
  refreshWindow.__vinextReactRefreshErrorRecoveryInstallScheduled = true;

  let timeoutPending = false;
  const scheduleTimeoutRetry = (delay: number): void => {
    if (timeoutPending) return;
    timeoutPending = true;
    window.setTimeout(() => {
      timeoutPending = false;
      retry();
    }, delay);
  };

  function retry(): void {
    if (tryInstallReactRefreshErrorRecovery()) {
      refreshWindow.__vinextReactRefreshErrorRecoveryInstallScheduled = false;
      return;
    }
    scheduleTimeoutRetry(REACT_REFRESH_RECOVERY_RETRY_DELAY_MS);
  }

  if (typeof queueMicrotask === "function") {
    queueMicrotask(retry);
  } else {
    void Promise.resolve().then(retry);
  }
  scheduleTimeoutRetry(0);
}

function tryInstallReactRefreshErrorRecovery(): boolean {
  if (typeof window === "undefined") return false;

  const refreshWindow = window as ReactRefreshWindow;
  if (refreshWindow.__vinextReactRefreshErrorRecoveryInstalled) return true;

  const register = refreshWindow.__registerBeforePerformReactRefresh;
  if (typeof register !== "function") return false;

  refreshWindow.__vinextReactRefreshErrorRecoveryInstalled = true;
  register(() => {
    window.dispatchEvent(new Event(VINEXT_DEV_ERROR_RECOVERY_EVENT));
    dismissOverlay();
  });
  return true;
}

export function reportInitialDevServerErrors(): void {
  if (typeof window === "undefined") return;

  const errors = window.__VINEXT_INITIAL_DEV_ERRORS__;
  if (!errors || errors.length === 0) return;

  window.__VINEXT_INITIAL_DEV_ERRORS__ = [];

  for (const payload of errors) {
    const error = new Error(payload.message);
    if (payload.name) {
      error.name = payload.name;
    }
    if (payload.stack) {
      error.stack = payload.stack;
    }
    reportDevError(error, { source: "server" });
  }
}

type ViteHmrHotContext = {
  data: Record<string, unknown>;
  on(event: string, cb: (payload: ViteHmrErrorPayload) => void): void;
  off?(event: string, cb: (payload: ViteHmrErrorPayload) => void): void;
  dispose?(cb: (data: Record<string, unknown>) => void): void;
};

type ViteHmrErrorPayload = {
  err?: ViteHmrError;
};

type ViteHmrError = {
  [name: string]: unknown;
  message?: unknown;
  frame?: unknown;
  plugin?: unknown;
};

type NormalizedViteHmrError = {
  message: string;
};

export function installViteHmrErrorHandler(hot: unknown): void {
  if (!isViteHmrHotContext(hot) || typeof window === "undefined") return;

  const previousHandler = hot.data[VITE_ERROR_HANDLER_DATA_KEY];
  if (typeof previousHandler === "function" && hot.off) {
    hot.off("vite:error", previousHandler as (payload: ViteHmrErrorPayload) => void);
  }

  const handler = (payload: ViteHmrErrorPayload): void => {
    reportViteHmrError(payload);
  };
  hot.on("vite:error", handler);
  hot.data[VITE_ERROR_HANDLER_DATA_KEY] = handler;
  hot.dispose?.((data) => {
    if (data[VITE_ERROR_HANDLER_DATA_KEY] === handler) {
      delete data[VITE_ERROR_HANDLER_DATA_KEY];
    }
  });
}

function isViteHmrHotContext(value: unknown): value is ViteHmrHotContext {
  if (!value || typeof value !== "object") return false;
  const hot = value as Partial<ViteHmrHotContext>;
  return typeof hot.on === "function" && !!hot.data && typeof hot.data === "object";
}

function reportViteHmrError(payload: ViteHmrErrorPayload): void {
  const normalized = normalizeViteHmrError(payload);
  // Vite build errors describe the current failed HMR update, so they replace
  // the whole overlay snapshot instead of stacking with older runtime or Vite
  // errors from previous edits.
  dismissOverlay();
  reportDevError(normalized.message, { source: "vite" });
}

export function normalizeViteHmrError(payload: ViteHmrErrorPayload): NormalizedViteHmrError {
  const err = payload?.err;
  if (!err || typeof err !== "object") {
    return { message: "Vite build error" };
  }

  const plugin = stringValue(err.plugin);
  const rawMessage = stringValue(err.message) ?? "Vite build error";
  const message = formatViteErrorMessage(rawMessage, plugin, stringValue(err.frame));
  return {
    message,
  };
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
  const id = reportToOverlay({
    source: options.source,
    message,
    stack,
    ignoredStackFrames: undefined,
    projectRoot: undefined,
    codeFrame: undefined,
    componentStack: options.componentStack,
  });

  void resolveBrowserStackTrace(stack).then((mappedStackTrace) => {
    if (
      mappedStackTrace.stack !== stack ||
      mappedStackTrace.ignoredFrames !== undefined ||
      mappedStackTrace.codeFrame ||
      mappedStackTrace.projectRoot
    ) {
      updateOverlayErrorStack(
        id,
        mappedStackTrace.stack,
        mappedStackTrace.ignoredFrames,
        mappedStackTrace.codeFrame,
        mappedStackTrace.projectRoot,
      );
    }
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
  if (isNavigationSignalError(error)) return;

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
  if (isNavigationSignalError(error)) return;

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

function formatViteErrorMessage(
  message: string,
  plugin: string | undefined,
  frame: string | undefined,
): string {
  const trimmedMessage = message.trim();
  const trimmedFrame = frame?.trim();
  const body =
    trimmedFrame && !trimmedMessage.includes(trimmedFrame)
      ? `${trimmedMessage}\n\n${trimmedFrame}`
      : trimmedMessage;
  return `${plugin ? `[plugin:${plugin}] ` : ""}${body || "Vite build error"}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ensureMounted(): void {
  if (reactRoot) return;
  const node = createDevErrorOverlayMountNode(document);
  reactRoot = createRoot(node);
  reactRoot.render(<DevErrorOverlayApp />);
}

export function createDevErrorOverlayMountNode(ownerDocument: Document): HTMLElement {
  let host = ownerDocument.getElementById(DEV_ERROR_OVERLAY_HOST_ID);
  if (!host) {
    host = ownerDocument.createElement("div");
    host.id = DEV_ERROR_OVERLAY_HOST_ID;
    configureDevErrorOverlayHost(host);
    // Fall back to documentElement in case body hasn't been parsed yet (e.g.
    // an extremely early hydration error firing before the body element is
    // attached). Either parent keeps the overlay outside the React-managed
    // hydrateRoot tree, which is what matters.
    (ownerDocument.body ?? ownerDocument.documentElement).appendChild(host);
  } else {
    configureDevErrorOverlayHost(host);
  }

  if (typeof host.attachShadow !== "function") {
    return host;
  }

  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  let mountNode = shadowRoot.getElementById(DEV_ERROR_OVERLAY_MOUNT_ID);
  if (!mountNode) {
    mountNode = ownerDocument.createElement("div");
    mountNode.id = DEV_ERROR_OVERLAY_MOUNT_ID;
    shadowRoot.appendChild(mountNode);
  }
  return mountNode;
}

function configureDevErrorOverlayHost(host: HTMLElement): void {
  host.setAttribute("data-vinext-dev-error-overlay", "");
  host.style.position = "absolute";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "0";
  host.style.height = "0";
  host.style.overflow = "visible";
  host.style.zIndex = "2147483647";
}

// ---------------------------------------------------------------------------
// React component tree
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<Source, string> = {
  server: "Server Error",
  vite: "Build Error",
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
  const isBuildError = error.source === "vite";
  const frames = useMemo(
    () =>
      error.stack && !isBuildError
        ? parseStack(error.stack).map((frame, frameIndex) =>
            createDisplayStackFrame(
              frame,
              error.ignoredStackFrames?.[frameIndex] ?? false,
              error.projectRoot,
            ),
          )
        : [],
    [error.stack, error.ignoredStackFrames, error.projectRoot, isBuildError],
  );
  const [showIgnoredFrames, setShowIgnoredFrames] = useState(false);
  const hasVisibleFrame = frames.some((frame) => !frame.ignored);
  const ignoredFramesTally = hasVisibleFrame
    ? frames.reduce((tally, frame) => tally + (frame.ignored ? 1 : 0), 0)
    : 0;
  const visibleFrames =
    showIgnoredFrames || ignoredFramesTally === 0
      ? frames
      : frames.filter((frame) => !frame.ignored);

  useEffect(() => {
    setShowIgnoredFrames(false);
  }, [error.id]);

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
          <div style={headerActionsStyle}>
            <CopyErrorButton error={error} frames={frames} />
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
          </div>
        </header>

        <div className="vinext-overlay-body" style={bodyStyle}>
          {isBuildError ? (
            <BuildErrorBlock message={error.message} />
          ) : (
            <h2 data-testid="vinext-dev-error-message" style={messageStyle}>
              {error.message}
            </h2>
          )}

          {error.codeFrame && !isBuildError ? (
            <CodeFrame codeFrame={error.codeFrame} projectRoot={error.projectRoot} />
          ) : null}

          {frames.length > 0 ? (
            <div data-testid="vinext-dev-error-stack-container" style={stackContainerStyle}>
              <div style={stackHeaderStyle}>
                <p style={stackTitleStyle}>
                  Call Stack
                  <span style={stackCountStyle}>{frames.length}</span>
                </p>
                {ignoredFramesTally > 0 ? (
                  <button
                    type="button"
                    data-testid="vinext-dev-error-ignored-frames-toggle"
                    data-vinext-ignored-frames-open={showIgnoredFrames}
                    className="vinext-overlay-ignored-frames-toggle"
                    onClick={() => setShowIgnoredFrames((open) => !open)}
                  >
                    {`${showIgnoredFrames ? "Hide" : "Show"} ${ignoredFramesTally} ignore-listed frame(s)`}
                    <span aria-hidden="true" style={ignoredFramesToggleIconStyle}>
                      ↕
                    </span>
                  </button>
                ) : null}
              </div>
              <ol data-testid="vinext-dev-error-stack" style={stackListStyle}>
                {visibleFrames.map((frame) => (
                  <StackFrameRow key={frame.key} frame={frame} />
                ))}
              </ol>
            </div>
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

function BuildErrorBlock({ message }: { message: string }): React.ReactNode {
  return (
    <section data-testid="vinext-dev-error-build-message" style={buildErrorBlockStyle}>
      <pre data-testid="vinext-dev-error-message" style={buildErrorPreStyle}>
        {message}
      </pre>
    </section>
  );
}

function CopyErrorButton({
  error,
  frames,
}: {
  error: ReportedError;
  frames: readonly DisplayFrame[];
}): React.ReactNode {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const label =
    copyState === "copied"
      ? "Error Info Copied"
      : copyState === "failed"
        ? "Copy Error Info Failed"
        : "Copy Error Info";

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  return (
    <button
      type="button"
      data-testid="vinext-dev-error-copy"
      data-vinext-copy-state={copyState}
      className="vinext-overlay-copy"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        void copyTextToClipboard(formatErrorInfoForClipboard(error, frames)).then((copied) =>
          setCopyState(copied ? "copied" : "failed"),
        );
      }}
    >
      <span aria-hidden="true">{copyState === "copied" ? <CheckIcon /> : <CopyIcon />}</span>
    </button>
  );
}

function CopyIcon(): React.ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path
        d="M5.5 4.5H11.5V12.5H5.5V4.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 9.5H2.5V2.5H8.5V3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon(): React.ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path
        d="M3.25 7.5L6.25 10.5L11.75 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CodeFrame({
  codeFrame,
  projectRoot,
}: {
  codeFrame: OverlayCodeFrame;
  projectRoot: string | undefined;
}): React.ReactNode {
  const location = formatCodeFrameLocation(codeFrame, projectRoot);
  const openInEditorFile = `${fileUrlToPath(codeFrame.file)}:${codeFrame.line}:${codeFrame.column}`;

  return (
    <section data-testid="vinext-dev-error-code-frame" style={codeFrameContainerStyle}>
      <header style={codeFrameHeaderStyle}>
        <span style={codeFrameLocationStyle}>{location}</span>
        <button
          type="button"
          data-vinext-open-in-editor
          className="vinext-overlay-code-frame-open"
          title={`Open ${openInEditorFile} in editor`}
          aria-label={`Open ${openInEditorFile} in editor`}
          onClick={(event) => {
            event.stopPropagation();
            openViteEditor(openInEditorFile);
          }}
        >
          ↗
        </button>
      </header>
      <pre className="vinext-overlay-code-frame-pre" style={codeFramePreStyle}>
        {codeFrame.lines.map((line) => (
          <Fragment key={line.line}>
            <span className="vinext-overlay-code-frame-line">
              <span style={codeFrameGutterStyle}>
                <span style={line.isErrorLine ? codeFrameErrorMarkerStyle : undefined}>
                  {line.isErrorLine ? ">" : " "}
                </span>
                {String(line.line).padStart(3, " ")} |
              </span>
              <span>{line.text || " "}</span>
            </span>
            {line.isErrorLine ? (
              <span style={codeFrameCaretLineStyle}>
                <span style={codeFrameGutterStyle}>{"     |"}</span>
                <span>{" ".repeat(Math.max(0, codeFrame.column - 1))}^</span>
              </span>
            ) : null}
          </Fragment>
        ))}
      </pre>
    </section>
  );
}

function formatCodeFrameLocation(
  codeFrame: OverlayCodeFrame,
  projectRoot: string | undefined,
): string {
  const file = formatOverlayDisplayFile(codeFrame.file, projectRoot);
  const methodName = codeFrame.methodName ? ` @ ${codeFrame.methodName}` : "";
  return `${file}:${codeFrame.line}:${codeFrame.column}${methodName}`;
}

function StackFrameRow({ frame }: { frame: DisplayFrame }): React.ReactNode {
  const openInEditorFile = formatStackFrameLocation(frame);
  const displayFile = frame.displayFile ?? frame.file;
  const content = (
    <>
      <span style={frameFnStyle}>{frame.fn}</span>
      {displayFile ? (
        <span style={frameLocStyle}>
          {displayFile}
          {frame.line ? `:${frame.line}` : ""}
          {frame.col ? `:${frame.col}` : ""}
        </span>
      ) : null}
    </>
  );

  if (!openInEditorFile) {
    return (
      <li
        className="vinext-overlay-frame"
        data-vinext-ignored-frame={frame.ignored || undefined}
        style={stackItemStyle}
      >
        {content}
      </li>
    );
  }

  return (
    <li
      className="vinext-overlay-frame"
      data-vinext-ignored-frame={frame.ignored || undefined}
      style={stackItemStyle}
    >
      <button
        type="button"
        data-vinext-open-in-editor
        className="vinext-overlay-frame-button"
        style={stackFrameButtonStyle}
        title={`Open ${openInEditorFile} in editor`}
        aria-label={`Open ${openInEditorFile} in editor`}
        onClick={(event) => {
          event.stopPropagation();
          openViteEditor(openInEditorFile);
        }}
      >
        {content}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Stack parsing — handles V8 ("    at fn (file:line:col)") and SpiderMonkey/
// JavaScriptCore ("fn@file:line:col") formats. Lines that don't match either
// shape are kept verbatim as a function-name-only frame so the overlay still
// renders something useful in unfamiliar runtimes.
// ---------------------------------------------------------------------------

type Frame = { key: string; fn: string; file?: string; line?: string; col?: string };
type FrameLocation = { file?: string; line?: string; col?: string };
type DisplayFrame = Frame & { displayFile?: string; ignored: boolean };
type ClipboardStackFrame = {
  fn: string;
  file?: string;
  displayFile?: string;
  line?: string;
  col?: string;
  ignored?: boolean;
};
type ClipboardErrorInfo = Pick<ReportedError, "source" | "message"> &
  Partial<Pick<ReportedError, "projectRoot" | "codeFrame" | "componentStack">>;

const V8_PAREN_FRAME = /^(.*?)\s*\((.+):(\d+):(\d+)\)$/;
const V8_BARE_FRAME = /^(.+):(\d+):(\d+)$/;
const MOZ_FRAME = /^(.*?)@(.+):(\d+):(\d+)$/;

function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  const lines = stack
    .split("\n")
    .map((raw) => raw.trim())
    .filter(Boolean);
  const firstLineIsMessage = lines.length > 1 && !isStackFrameLine(lines[0]!);
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
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (index === 0 && firstLineIsMessage) continue;

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

function isStackFrameLine(line: string): boolean {
  return line.startsWith("at ") || MOZ_FRAME.test(line);
}

function createDisplayStackFrame(
  frame: Frame,
  ignored: boolean,
  projectRoot: string | undefined,
): DisplayFrame {
  const normalizedFrame = normalizeStackFrameLocation(frame);
  return {
    ...frame,
    ...normalizedFrame,
    ...(normalizedFrame.file
      ? { displayFile: formatOverlayDisplayFile(normalizedFrame.file, projectRoot) }
      : {}),
    ignored,
  };
}

function normalizeStackFrameLocation(frame: FrameLocation): FrameLocation {
  if (!frame.file) return frame;

  return {
    ...frame,
    file: fileUrlToPath(devirtualizeReactServerUrl(frame.file)),
  };
}

function devirtualizeReactServerUrl(sourceUrl: string): string {
  if (sourceUrl.startsWith("about://React/")) {
    // Same shape Next.js normalizes in server/lib/source-maps:
    // about://React/Server/file://<filename>?42 => file://<filename>
    const envIdx = sourceUrl.indexOf("/", "about://React/".length);
    const suffixIdx = sourceUrl.lastIndexOf("?");
    if (envIdx > -1 && suffixIdx > -1) {
      return sourceUrl.slice(envIdx + 1, suffixIdx);
    }
  }
  return sourceUrl;
}

function fileUrlToPath(sourceUrl: string): string {
  if (!sourceUrl.startsWith("file://")) return sourceUrl;

  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "file:") return sourceUrl;
    const pathname = decodeURIComponent(url.pathname);
    if (url.hostname) {
      return `//${url.hostname}${pathname}`;
    }
    return pathname.replace(/^\/([A-Za-z]:)/, "$1");
  } catch {
    return sourceUrl;
  }
}

export function formatOverlayDisplayFile(file: string, projectRoot?: string): string {
  const normalizedFile = normalizeDisplayPath(fileUrlToPath(devirtualizeReactServerUrl(file)));
  const normalizedRoot = projectRoot
    ? stripTrailingDisplaySlash(normalizeDisplayPath(fileUrlToPath(projectRoot)))
    : undefined;
  if (!normalizedRoot) return normalizedFile;

  const fileForCompare = normalizeCaseForPathCompare(normalizedFile);
  const rootForCompare = normalizeCaseForPathCompare(normalizedRoot);
  if (fileForCompare === rootForCompare) return ".";

  const rootPrefix = `${rootForCompare}/`;
  if (!fileForCompare.startsWith(rootPrefix)) return normalizedFile;

  return normalizedFile.slice(normalizedRoot.length + 1);
}

function normalizeDisplayPath(file: string): string {
  return file.replaceAll("\\", "/");
}

function stripTrailingDisplaySlash(file: string): string {
  const stripped = file.replace(/\/+$/, "");
  return stripped || (file.startsWith("/") ? "/" : "");
}

function normalizeCaseForPathCompare(file: string): string {
  return /^[A-Za-z]:\//.test(file) ? file.toLowerCase() : file;
}

function formatStackFrameLocation(frame: FrameLocation): string | null {
  if (!frame.file) return null;

  if (frame.line && frame.col) {
    return `${frame.file}:${frame.line}:${frame.col}`;
  }
  if (frame.line) {
    return `${frame.file}:${frame.line}`;
  }
  return frame.file;
}

export function formatErrorInfoForClipboard(
  error: ClipboardErrorInfo,
  frames: readonly ClipboardStackFrame[],
): string {
  const sections = [
    `## Error Type\n\n${SOURCE_LABEL[error.source]}`,
    `## Error Message\n\n${error.message}`,
  ];
  const stackFrames = getClipboardStackFrames(frames);

  if (error.source !== "vite" && stackFrames.length > 0) {
    sections.push(`## Stack\n\n${stackFrames.map(formatClipboardStackFrame).join("\n")}`);
  }
  if (error.source !== "vite" && error.codeFrame) {
    sections.push(
      `## Code Frame\n\n${formatClipboardCodeFrame(error.codeFrame, error.projectRoot)}`,
    );
  }
  if (error.componentStack) {
    sections.push(`## Component Stack\n\n${error.componentStack.trim()}`);
  }

  return sections.join("\n\n");
}

function getClipboardStackFrames(
  frames: readonly ClipboardStackFrame[],
): readonly ClipboardStackFrame[] {
  const visibleFrames = frames.filter((frame) => !frame.ignored);
  return visibleFrames.length > 0 ? visibleFrames : frames;
}

function formatClipboardStackFrame(frame: ClipboardStackFrame): string {
  const location = formatStackFrameLocation({
    file: frame.displayFile ?? frame.file,
    line: frame.line,
    col: frame.col,
  });
  return location ? `    at ${frame.fn} (${location})` : `    at ${frame.fn}`;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to execCommand below. Some embedded dev browsers expose the
      // Clipboard API but still reject writes from overlay event handlers.
    }
  }

  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  try {
    (document.body ?? document.documentElement).appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function formatClipboardCodeFrame(
  codeFrame: OverlayCodeFrame,
  projectRoot: string | undefined,
): string {
  const lineNumberWidth = Math.max(3, ...codeFrame.lines.map((line) => String(line.line).length));
  const lines = codeFrame.lines.flatMap((line) => {
    const marker = line.isErrorLine ? ">" : " ";
    const formattedLine = `${marker} ${String(line.line).padStart(lineNumberWidth, " ")} | ${
      line.text
    }`;
    if (!line.isErrorLine) return [formattedLine];
    const caretLine = `  ${" ".repeat(lineNumberWidth)} | ${" ".repeat(
      Math.max(0, codeFrame.column - 1),
    )}^`;
    return [formattedLine, caretLine];
  });

  return [formatCodeFrameLocation(codeFrame, projectRoot), ...lines].join("\n");
}

export function formatViteOpenInEditorFile(frame: FrameLocation): string | null {
  return formatStackFrameLocation(normalizeStackFrameLocation(frame));
}

export function createViteOpenInEditorUrl(file: string, baseUrl = import.meta.url): string {
  return new URL(`/__open-in-editor?file=${encodeURIComponent(file)}`, baseUrl).toString();
}

function openViteEditor(file: string): void {
  if (typeof fetch !== "function") return;
  void fetch(createViteOpenInEditorUrl(file)).catch(() => {});
}

async function resolveBrowserStackTrace(stack: string | undefined): Promise<{
  stack: string | undefined;
  ignoredFrames?: boolean[];
  projectRoot?: string;
  codeFrame?: OverlayCodeFrame;
}> {
  if (!stack || typeof window === "undefined" || typeof fetch !== "function") {
    return { stack };
  }

  try {
    const response = await fetch(VINEXT_ORIGINAL_STACK_TRACE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack }),
    });
    if (!response.ok) return { stack };
    const payload = (await response.json()) as {
      stack?: unknown;
      ignoredFrames?: unknown;
      projectRoot?: unknown;
      codeFrame?: unknown;
    };
    const ignoredFrames = Array.isArray(payload.ignoredFrames)
      ? payload.ignoredFrames.filter((value): value is boolean => typeof value === "boolean")
      : undefined;
    const codeFrame = parseOverlayCodeFrame(payload.codeFrame);
    return {
      stack: typeof payload.stack === "string" ? payload.stack : stack,
      ignoredFrames,
      ...(typeof payload.projectRoot === "string" && payload.projectRoot
        ? { projectRoot: payload.projectRoot }
        : {}),
      ...(codeFrame ? { codeFrame } : {}),
    };
  } catch {
    return { stack };
  }
}

function parseOverlayCodeFrame(value: unknown): OverlayCodeFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as {
    file?: unknown;
    line?: unknown;
    column?: unknown;
    methodName?: unknown;
    lines?: unknown;
  };
  const file = typeof payload.file === "string" ? payload.file : undefined;
  const line =
    typeof payload.line === "number" && Number.isInteger(payload.line) ? payload.line : undefined;
  const column =
    typeof payload.column === "number" && Number.isInteger(payload.column)
      ? payload.column
      : undefined;
  const rawLines = Array.isArray(payload.lines) ? payload.lines : undefined;
  if (!file || line === undefined || column === undefined || !rawLines) {
    return undefined;
  }

  const lines = rawLines
    .map((rawLine): OverlayCodeFrame["lines"][number] | null => {
      if (!rawLine || typeof rawLine !== "object") return null;
      const item = rawLine as { line?: unknown; text?: unknown; isErrorLine?: unknown };
      if (
        typeof item.line !== "number" ||
        !Number.isInteger(item.line) ||
        typeof item.text !== "string"
      ) {
        return null;
      }
      const line = item.line;
      return {
        line,
        text: item.text,
        isErrorLine: item.isErrorLine === true,
      };
    })
    .filter((line): line is OverlayCodeFrame["lines"][number] => line !== null);
  if (lines.length === 0) return undefined;

  return {
    file,
    line,
    column,
    ...(typeof payload.methodName === "string" && payload.methodName
      ? { methodName: payload.methodName }
      : {}),
    lines,
  };
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
#${DEV_ERROR_OVERLAY_MOUNT_ID} {
  color-scheme: dark;
  --vinext-overlay-backdrop: rgba(10, 10, 12, 0.55);
  --vinext-overlay-dialog-bg: #0a0a0a;
  --vinext-overlay-fg: #fafafa;
  --vinext-overlay-muted: #a1a1aa;
  --vinext-overlay-subtle: #71717a;
  --vinext-overlay-border: rgba(255, 255, 255, 0.08);
  --vinext-overlay-divider: rgba(255, 255, 255, 0.06);
  --vinext-overlay-hover: rgba(255, 255, 255, 0.08);
  --vinext-overlay-toggle-hover: rgba(255, 255, 255, 0.06);
  --vinext-overlay-focus: rgba(250, 250, 250, 0.65);
  --vinext-overlay-danger: #ef4444;
  --vinext-overlay-danger-fg: #fca5a5;
  --vinext-overlay-danger-bg: rgba(239, 68, 68, 0.12);
  --vinext-overlay-danger-muted-bg: rgba(239, 68, 68, 0.18);
  --vinext-overlay-danger-border: rgba(239, 68, 68, 0.25);
  --vinext-overlay-danger-strong-border: rgba(239, 68, 68, 0.45);
  --vinext-overlay-danger-strong-border-hover: rgba(239, 68, 68, 0.7);
  --vinext-overlay-success: #22c55e;
  --vinext-overlay-success-border: rgba(34, 197, 94, 0.4);
  --vinext-overlay-count-bg: rgba(255, 255, 255, 0.1);
  --vinext-overlay-count-fg: #d4d4d8;
  --vinext-overlay-code-bg: rgba(255, 255, 255, 0.03);
  --vinext-overlay-code-gutter: #71717a;
  --vinext-overlay-indicator-bg: #18181b;
  --vinext-overlay-indicator-bg-hover: #1f1f23;
  --vinext-overlay-scrollbar-thumb: rgba(161, 161, 170, 0.5);
  --vinext-overlay-scrollbar-thumb-hover: rgba(212, 212, 216, 0.65);
  --vinext-overlay-scrollbar-border: #0a0a0a;
}
@media (prefers-color-scheme: light) {
  #${DEV_ERROR_OVERLAY_MOUNT_ID} {
    color-scheme: light;
    --vinext-overlay-backdrop: rgba(39, 39, 42, 0.42);
    --vinext-overlay-dialog-bg: #ffffff;
    --vinext-overlay-fg: #18181b;
    --vinext-overlay-muted: #71717a;
    --vinext-overlay-subtle: #52525b;
    --vinext-overlay-border: rgba(24, 24, 27, 0.12);
    --vinext-overlay-divider: rgba(24, 24, 27, 0.08);
    --vinext-overlay-hover: rgba(24, 24, 27, 0.07);
    --vinext-overlay-toggle-hover: rgba(24, 24, 27, 0.055);
    --vinext-overlay-focus: rgba(24, 24, 27, 0.45);
    --vinext-overlay-danger: #dc2626;
    --vinext-overlay-danger-fg: #b91c1c;
    --vinext-overlay-danger-bg: rgba(220, 38, 38, 0.1);
    --vinext-overlay-danger-muted-bg: rgba(220, 38, 38, 0.1);
    --vinext-overlay-danger-border: rgba(220, 38, 38, 0.22);
    --vinext-overlay-danger-strong-border: rgba(220, 38, 38, 0.3);
    --vinext-overlay-danger-strong-border-hover: rgba(220, 38, 38, 0.45);
    --vinext-overlay-success: #16a34a;
    --vinext-overlay-success-border: rgba(22, 163, 74, 0.4);
    --vinext-overlay-count-bg: rgba(24, 24, 27, 0.08);
    --vinext-overlay-count-fg: #52525b;
    --vinext-overlay-code-bg: rgba(24, 24, 27, 0.025);
    --vinext-overlay-code-gutter: #71717a;
    --vinext-overlay-indicator-bg: #ffffff;
    --vinext-overlay-indicator-bg-hover: #f4f4f5;
    --vinext-overlay-scrollbar-thumb: rgba(113, 113, 122, 0.45);
    --vinext-overlay-scrollbar-thumb-hover: rgba(82, 82, 91, 0.62);
    --vinext-overlay-scrollbar-border: #ffffff;
  }
}
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
  background: var(--vinext-overlay-hover);
}
.vinext-overlay-nav:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.vinext-overlay-close {
  background: transparent;
  border: none;
  color: var(--vinext-overlay-muted);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background 0.12s ease, color 0.12s ease;
}
.vinext-overlay-close:hover {
  background: var(--vinext-overlay-hover);
  color: var(--vinext-overlay-fg);
}
.vinext-overlay-close { font-size: 20px; }
.vinext-overlay-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--vinext-overlay-border);
  border-radius: 999px;
  color: var(--vinext-overlay-muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.vinext-overlay-copy:hover {
  background: var(--vinext-overlay-hover);
  color: var(--vinext-overlay-fg);
}
.vinext-overlay-copy:focus-visible {
  outline: 2px solid var(--vinext-overlay-focus);
  outline-offset: 2px;
}
.vinext-overlay-copy[data-vinext-copy-state="copied"] {
  color: var(--vinext-overlay-success);
  border-color: var(--vinext-overlay-success-border);
}
.vinext-overlay-copy > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.vinext-overlay-frame {
  padding: 8px 12px 8px 4px;
  border-radius: 6px;
}
.vinext-overlay-frame[data-vinext-ignored-frame="true"] {
  opacity: 0.58;
}
.vinext-overlay-frame-button {
  all: unset;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  cursor: pointer;
}
.vinext-overlay-frame-button:focus-visible {
  outline: 2px solid var(--vinext-overlay-focus);
  outline-offset: 3px;
}
.vinext-overlay-code-frame-line {
  display: flex;
  gap: 10px;
  min-width: max-content;
  padding: 0 10px;
}
.vinext-overlay-code-frame-open {
  all: unset;
  color: var(--vinext-overlay-muted);
  cursor: pointer;
  font: 600 13px ${FONT_STACK};
  line-height: 1;
  padding: 4px;
  border-radius: 6px;
}
.vinext-overlay-code-frame-open:hover {
  background: var(--vinext-overlay-hover);
  color: var(--vinext-overlay-fg);
}
.vinext-overlay-code-frame-open:focus-visible {
  outline: 2px solid var(--vinext-overlay-focus);
  outline-offset: 2px;
}
.vinext-overlay-body,
.vinext-overlay-code-frame-pre {
  scrollbar-width: thin;
  scrollbar-color: var(--vinext-overlay-scrollbar-thumb) transparent;
}
.vinext-overlay-body {
  scrollbar-gutter: stable both-edges;
}
.vinext-overlay-body::-webkit-scrollbar,
.vinext-overlay-code-frame-pre::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.vinext-overlay-body::-webkit-scrollbar-button,
.vinext-overlay-code-frame-pre::-webkit-scrollbar-button {
  display: none;
}
.vinext-overlay-body::-webkit-scrollbar-track,
.vinext-overlay-code-frame-pre::-webkit-scrollbar-track {
  background: transparent;
}
.vinext-overlay-body::-webkit-scrollbar-thumb,
.vinext-overlay-code-frame-pre::-webkit-scrollbar-thumb {
  min-height: 44px;
  background: var(--vinext-overlay-scrollbar-thumb);
  border-radius: 999px;
}
.vinext-overlay-body::-webkit-scrollbar-thumb:hover,
.vinext-overlay-code-frame-pre::-webkit-scrollbar-thumb:hover {
  background: var(--vinext-overlay-scrollbar-thumb-hover);
}
.vinext-overlay-body::-webkit-scrollbar-corner,
.vinext-overlay-code-frame-pre::-webkit-scrollbar-corner {
  background: transparent;
}
.vinext-overlay-ignored-frames-toggle {
  all: unset;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  color: var(--vinext-overlay-muted);
  font: 500 13px ${FONT_STACK};
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.vinext-overlay-ignored-frames-toggle:hover {
  background: var(--vinext-overlay-toggle-hover);
  color: var(--vinext-overlay-fg);
}
.vinext-overlay-ignored-frames-toggle:focus-visible {
  outline: 2px solid var(--vinext-overlay-focus);
  outline-offset: 2px;
}
.vinext-overlay-indicator {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--vinext-overlay-indicator-bg);
  color: var(--vinext-overlay-fg);
  border: 1px solid var(--vinext-overlay-danger-strong-border);
  font: 600 13px ${FONT_STACK};
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
  animation: vinextOverlayIndicatorIn 0.18s ease-out;
}
.vinext-overlay-indicator:hover {
  background: var(--vinext-overlay-indicator-bg-hover);
  border-color: var(--vinext-overlay-danger-strong-border-hover);
  transform: translateY(-1px);
}
`;

const backdropStyle: React.CSSProperties = {
  // The backdrop captures click-outside-to-minimize as a proper modal would —
  // a click on it dismisses the overlay rather than reaching the page
  // underneath. The dialog re-enables pointer events for itself via
  // dialogStyle.
  position: "fixed",
  inset: "10vh 0 0",
  margin: 8,
  background: "transparent",
  display: "flex",
  alignItems: "center",
  flexDirection: "column",
  zIndex: 2147483646,
  animation: "vinextOverlayBackdropIn 0.15s ease-out",
};

const dialogStyle: React.CSSProperties = {
  position: "relative",
  pointerEvents: "auto",
  boxSizing: "border-box",
  width: "min(960px, calc(100vw - 16px))",
  maxHeight: "min(80vh, 720px)",
  display: "flex",
  flexDirection: "column",
  background: "var(--vinext-overlay-dialog-bg)",
  color: "var(--vinext-overlay-fg)",
  border: "1px solid var(--vinext-overlay-border)",
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
  color: "var(--vinext-overlay-danger)",
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
  background: "var(--vinext-overlay-danger-muted-bg)",
  color: "var(--vinext-overlay-danger-fg)",
  fontSize: 11,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 19px 14px 16px",
};

const headerLeftStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
};

const headerActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flex: "0 0 auto",
};

const badgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "var(--vinext-overlay-danger-bg)",
  color: "var(--vinext-overlay-danger-fg)",
  border: "1px solid var(--vinext-overlay-danger-border)",
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
  color: "var(--vinext-overlay-muted)",
  fontSize: 12,
};

const counterStyle: React.CSSProperties = {
  padding: "0 4px",
  fontVariantNumeric: "tabular-nums",
};

const bodyStyle: React.CSSProperties = {
  padding: "0 12px 20px",
  overflowX: "hidden",
  overflowY: "auto",
  flex: 1,
};

const messageStyle: React.CSSProperties = {
  margin: "0 4px 16px",
  fontFamily: MONO_STACK,
  fontSize: 16,
  fontWeight: 500,
  lineHeight: 1.45,
  color: "var(--vinext-overlay-fg)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const buildErrorBlockStyle: React.CSSProperties = {
  margin: "0 -5px 18px",
  border: "1px solid var(--vinext-overlay-border)",
  borderRadius: 8,
  overflow: "hidden",
  background: "var(--vinext-overlay-code-bg)",
};

const buildErrorPreStyle: React.CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  overflow: "auto",
  fontFamily: MONO_STACK,
  fontSize: 13,
  lineHeight: 1.6,
  color: "var(--vinext-overlay-fg)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const codeFrameContainerStyle: React.CSSProperties = {
  margin: "0 -5px 18px",
  border: "1px solid var(--vinext-overlay-border)",
  borderRadius: 8,
  overflow: "hidden",
  background: "var(--vinext-overlay-code-bg)",
};

const codeFrameHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 10px 8px 8px",
  borderBottom: "1px solid var(--vinext-overlay-divider)",
  fontFamily: MONO_STACK,
  fontSize: 12,
};

const codeFrameLocationStyle: React.CSSProperties = {
  color: "var(--vinext-overlay-fg)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const codeFramePreStyle: React.CSSProperties = {
  margin: 0,
  padding: "10px 0",
  overflow: "auto",
  fontFamily: MONO_STACK,
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--vinext-overlay-muted)",
};

const codeFrameGutterStyle: React.CSSProperties = {
  flex: "0 0 auto",
  color: "var(--vinext-overlay-code-gutter)",
  userSelect: "none",
};

const codeFrameErrorMarkerStyle: React.CSSProperties = {
  color: "var(--vinext-overlay-danger)",
};

const codeFrameCaretLineStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  minWidth: "max-content",
  padding: "0 10px",
  color: "var(--vinext-overlay-danger)",
};

const stackContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const stackHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  minHeight: 28,
  padding: "0 4px 4px",
  gap: 12,
};

const stackTitleStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  margin: 0,
  color: "var(--vinext-overlay-fg)",
  fontFamily: FONT_STACK,
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
};

const stackCountStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 20,
  height: 20,
  padding: "0 6px",
  borderRadius: 999,
  background: "var(--vinext-overlay-count-bg)",
  color: "var(--vinext-overlay-count-fg)",
  fontSize: 11,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};

const ignoredFramesToggleIconStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
  lineHeight: 1,
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

const stackFrameButtonStyle: React.CSSProperties = {
  color: "inherit",
  font: "inherit",
};

const frameFnStyle: React.CSSProperties = {
  color: "var(--vinext-overlay-fg)",
  fontWeight: 500,
};

const frameLocStyle: React.CSSProperties = {
  color: "var(--vinext-overlay-subtle)",
  fontSize: 11,
};

const detailsStyle: React.CSSProperties = {
  marginTop: 16,
  paddingTop: 12,
  borderTop: "1px solid var(--vinext-overlay-divider)",
  color: "var(--vinext-overlay-muted)",
  fontSize: 12,
};

const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  userSelect: "none",
  padding: "4px 0",
  color: "var(--vinext-overlay-muted)",
  fontWeight: 500,
};

const componentStackStyle: React.CSSProperties = {
  margin: "8px 0 0 0",
  fontFamily: MONO_STACK,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "var(--vinext-overlay-muted)",
};
