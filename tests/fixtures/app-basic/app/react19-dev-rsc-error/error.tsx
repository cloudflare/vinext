"use client";

export default function React19DevRscErrorBoundary({
  error,
}: {
  error: Error;
}) {
  return (
    <div data-testid="react19-dev-rsc-error-boundary">
      <h2>React 19 dev-mode error boundary rendered</h2>
      <p data-testid="react19-dev-rsc-error-message">{error.message}</p>
    </div>
  );
}
