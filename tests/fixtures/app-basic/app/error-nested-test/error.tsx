"use client";

export default function OuterErrorBoundary({ error }: { error: Error; reset: () => void }) {
  return (
    <div data-testid="outer-error-boundary">
      <p data-testid="outer-error-message">Outer: {error.message}</p>
    </div>
  );
}
