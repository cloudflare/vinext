"use client";

export default function InnerErrorBoundary({ error }: { error: Error; reset: () => void }) {
  return (
    <div data-testid="inner-error-boundary">
      <p data-testid="inner-error-message">Inner: {error.message}</p>
    </div>
  );
}
