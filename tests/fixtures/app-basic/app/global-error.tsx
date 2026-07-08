"use client";

import { usePathname } from "next/navigation";

/**
 * Global error boundary — catches errors in the root layout.
 * Must include its own <html> and <body> tags since it replaces the root layout.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Exercises the built-in fallback: when global-error.tsx itself throws during
  // render, vinext (like Next.js) should render the default global-error UI
  // instead of crashing the request. Keyed on the pathname (not the error
  // message, which is sanitized in production) so it fires in both dev and prod
  // and only for the dedicated /nextjs-compat/global-error-self-throw fixture.
  const pathname = usePathname();
  if (pathname === "/nextjs-compat/global-error-self-throw") {
    throw new Error("custom global error boundary threw");
  }
  return (
    <html>
      <body>
        <div data-testid="global-error">
          <h1>Something went wrong!</h1>
          <p data-testid="global-error-message">{error.message}</p>
          {error.digest ? <p data-testid="global-error-digest">{error.digest}</p> : null}
          <button onClick={reset}>Try again</button>
        </div>
      </body>
    </html>
  );
}
