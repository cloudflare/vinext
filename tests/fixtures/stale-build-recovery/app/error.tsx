"use client";

export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div id="error-boundary">
      <p id="error-message">{error.message}</p>
      <button id="reset" onClick={reset} type="button">
        Try again
      </button>
    </div>
  );
}
