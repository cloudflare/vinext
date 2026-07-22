"use client";

import { useState } from "react";

export function DevOverlayTriggers() {
  const [renderThrow, setRenderThrow] = useState(false);

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
    </div>
  );
}
