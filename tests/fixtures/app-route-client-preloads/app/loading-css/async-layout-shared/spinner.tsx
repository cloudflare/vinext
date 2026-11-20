"use client";

import "./spinner.css";

// Awaits at the top level on the server, so a render streams it, though it
// loads well before the async layout below the fallback resolves.
if (typeof window === "undefined") {
  await Promise.resolve();
}

export function Spinner() {
  return (
    <p className="loading-css-shared-spinner" data-testid="loading-css-shared-spinner">
      Spinner
    </p>
  );
}
