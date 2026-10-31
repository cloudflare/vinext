"use client";

/**
 * Catches the render errors of the routes below, as the issue's `app/error.tsx`
 * does: https://github.com/cloudflare/vinext/issues/4394
 */
export default function ErrorBoundaryStatusBoundary({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <div data-testid="error-boundary-status">
      <h2>error-boundary-status caught</h2>
      <p data-testid="error-boundary-status-message">{error.message}</p>
    </div>
  );
}
