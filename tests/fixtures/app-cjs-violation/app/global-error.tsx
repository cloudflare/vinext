"use client";

/**
 * Global error boundary for testing server-only violation errors.
 * The E2E test checks for the "global-error-message" test ID.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div data-testid="global-error">
          <h1>Something went wrong!</h1>
          <p data-testid="global-error-message">{error.message}</p>
          <button onClick={reset}>Try again</button>
        </div>
      </body>
    </html>
  );
}
