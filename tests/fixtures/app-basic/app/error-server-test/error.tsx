"use client";

export default function ErrorServerBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div data-testid="server-error-boundary">
      <h2>Server Error Caught</h2>
      <p data-testid="server-error-message">{error.message}</p>
      <button data-testid="server-error-reset" onClick={reset}>
        Retry
      </button>
    </div>
  );
}
