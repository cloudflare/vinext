"use client";

import { useRef, useState } from "react";

export function DevOverlayTriggers() {
  const [renderThrow, setRenderThrow] = useState(false);
  const resizeLoopTarget = useRef<HTMLDivElement>(null);

  if (renderThrow) {
    // Reproduces the "DropZone is not defined" style failure: a runtime
    // ReferenceError thrown during render with no error boundary above.
    throw new ReferenceError("DropZone is not defined");
  }

  return (
    <div>
      <button data-testid="trigger-render-error" onClick={() => setRenderThrow(true)}>
        Trigger render error
      </button>
      <button
        data-testid="trigger-window-error"
        onClick={() => {
          // Asynchronously thrown so it bypasses React and lands on
          // window.onerror, like a misbehaving third-party script would.
          setTimeout(() => {
            throw new Error("uncaught timer error");
          }, 0);
        }}
      >
        Trigger window error
      </button>
      <button
        data-testid="trigger-unhandled-rejection"
        onClick={() => {
          // No .catch() — must reach window.onunhandledrejection.
          void Promise.reject(new Error("unhandled rejection from button"));
        }}
      >
        Trigger unhandled rejection
      </button>
      <button
        data-testid="trigger-resize-observer-loop"
        onClick={() => {
          const target = resizeLoopTarget.current;
          if (!target) return;
          // Resizing the observed element inside its own callback makes
          // Chromium fire a window "error" event with `error === null` and the
          // message "ResizeObserver loop completed with undelivered
          // notifications." No script failed, so the overlay must stay closed.
          let resizes = 0;
          const observer = new ResizeObserver(() => {
            resizes++;
            target.style.width = `${20 + resizes * 10}px`;
            if (resizes > 2) observer.disconnect();
          });
          observer.observe(target);
        }}
      >
        Trigger ResizeObserver loop
      </button>
      <div ref={resizeLoopTarget} style={{ width: 10, height: 10 }} />
    </div>
  );
}
