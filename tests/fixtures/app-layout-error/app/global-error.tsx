"use client";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html>
      <body>
        <h1 id="global-error">Global Error</h1>
        <p id="global-error-message">{error.message}</p>
        {error.digest && <p id="global-error-digest">{error.digest}</p>}
      </body>
    </html>
  );
}
