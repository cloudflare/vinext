"use client";

import { s } from "./_styles.js";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main style={s.center}>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Something went wrong</h1>
      <p data-testid="error-message" style={{ ...s.card, ...s.mono }}>
        {error.message}
      </p>
      {error.digest && (
        <p style={s.mono}>Digest: {error.digest}</p>
      )}
      <button data-testid="error-reset" onClick={() => reset()} style={s.btn}>
        Try again
      </button>
    </main>
  );
}
