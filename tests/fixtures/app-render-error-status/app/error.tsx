"use client";

export default function ErrorBoundary({ error }: { error: Error & { digest?: string } }) {
  return (
    <>
      <h1 id="error-boundary">error.tsx rendered, digest: {error.digest}</h1>
      <p id="error-message">{error.message}</p>
    </>
  );
}
