"use client";

export default function FalsyErrorBoundary({
  error,
  reset,
}: {
  error: unknown;
  reset: () => void;
}) {
  return (
    <div data-testid="falsy-error-boundary">
      <p data-testid="falsy-error-message">{String(error)}</p>
      <button data-testid="falsy-error-reset" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
