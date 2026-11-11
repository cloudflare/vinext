import Link from "next/link";

export default function RouteHandlerLinksPage() {
  return (
    <main>
      <h1 id="route-handler-links-home">Route handler links</h1>
      <Link href="/route-handler-links/internal-status" id="internal-status-link">
        Internal status
      </Link>
      <Link href="/route-handler-links/docs/intro" id="docs-intro-link">
        Docs intro
      </Link>
      <Link href="/route-handler-links/docs/shadowing-endpoint" id="shadowing-endpoint-link">
        Route handler under the docs catch-all
      </Link>
    </main>
  );
}
