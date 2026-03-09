"use client";

/**
 * Global error boundary — catches errors in the root layout.
 * Must include its own <html> and <body> tags since it replaces the root layout.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
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
