"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  // The built-in global-error takes over when this one throws.
  if (new URLSearchParams(window.location.search).has("throw-global-error")) {
    throw new Error("global-error.tsx failed");
  }
  return (
    <html>
      <body>
        <h1 id="global-error">global-error.tsx rendered</h1>
        <p id="global-error-digest">{error.digest}</p>
        <p id="global-error-message">{error.message}</p>
      </body>
    </html>
  );
}
