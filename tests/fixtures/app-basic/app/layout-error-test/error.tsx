"use client";

export default function LayoutErrorBoundary({ error }: { error: Error }) {
  return (
    <div data-testid="layout-error-boundary">
      <p data-testid="layout-error-message">{error.message}</p>
    </div>
  );
}
