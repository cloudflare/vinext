import Link from "next/link";

const DANGEROUS_DATA_REDIRECT =
  "javascript:void(window.__VINEXT_PAGES_DATA_REDIRECT_EXECUTED__=true)";

export default function DataRedirectTriggerPage() {
  return (
    <main>
      <Link
        id="data-redirect-link"
        href={`/nextjs-compat/javascript-urls/data-redirect?next=${encodeURIComponent(DANGEROUS_DATA_REDIRECT)}`}
      >
        Data redirect
      </Link>
      <Link
        id="middleware-redirect-link"
        href="/nextjs-compat/javascript-urls/middleware-dangerous-redirect"
      >
        Middleware redirect
      </Link>
    </main>
  );
}
