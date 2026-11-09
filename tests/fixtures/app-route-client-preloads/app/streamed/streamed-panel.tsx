"use client";

import "./streamed-panel.css";

// Awaits at the top level on the server, so its module evaluates
// asynchronously: a first render streams the Suspense fallback ahead of it.
if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export function StreamedPanel() {
  return (
    <p className="streamed-panel" data-testid="streamed-panel">
      panel
    </p>
  );
}
