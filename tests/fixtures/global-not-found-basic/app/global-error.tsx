"use client";

export default function GlobalError({ error }: { error: Error }) {
  return (
    <html>
      <head></head>
      <body>
        <h1>Global Error</h1>
        <p id="error">{`Global error: ${error}`}</p>
        {error?.digest && <p id="digest">{error?.digest}</p>}
      </body>
    </html>
  );
}
