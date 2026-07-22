"use client";

export default function ErrorBoundary({ error }: { error: Error }) {
  return (
    <main id="action-body-limit-error">
      <h2 id="error">Something went wrong!</h2>
      <p id="action-body-limit-error-message">{error.message}</p>
    </main>
  );
}
