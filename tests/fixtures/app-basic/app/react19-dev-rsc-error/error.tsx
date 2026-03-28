// This error boundary exists so the route has a realistic structure (matching
// how real apps would set up error handling). During SSR, React falls back to
// client rendering before this boundary fires, so the test asserts client-render
// fallback behavior rather than error boundary rendering.
"use client";

export default function React19DevRscErrorBoundary({ error }: { error: Error }) {
  return (
    <div data-testid="react19-dev-rsc-error-boundary">
      <h2>React 19 dev-mode error boundary rendered</h2>
      <p data-testid="react19-dev-rsc-error-message">{error.message}</p>
    </div>
  );
}
