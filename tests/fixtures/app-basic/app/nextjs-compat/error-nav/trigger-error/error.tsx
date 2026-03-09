"use client";
import Link from "next/link";
export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div id="error-boundary">
      <h2 id="error-message">{error.message}</h2>
      <button id="reset-btn" onClick={reset}>
        Try Again
      </button>
      <Link href="/nextjs-compat/error-nav" id="link-back-home">
        Go Home
      </Link>
      <Link href="/nextjs-compat/nav-redirect-result" id="link-to-result">
        Go to Result
      </Link>
    </div>
  );
}
