"use client";

export default function ThrowStringErrorBoundary({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div data-testid="string-error-boundary">
      <h2>String Error Caught</h2>
      <p data-testid="string-error-message">{error.message}</p>
      <button data-testid="string-error-reset" onClick={reset}>
        Retry
      </button>
    </div>
  );
}
