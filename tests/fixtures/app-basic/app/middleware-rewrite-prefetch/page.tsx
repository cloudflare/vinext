import Link from "next/link";

// `/middleware-rewrite-prefetch-target` matches no App route by itself.
// middleware.ts rewrites it to /about, so only the server can resolve it.
// Coverage: tests/e2e/app-router-prod/middleware-rewrite-prefetch.spec.ts
export default function MiddlewareRewritePrefetchPage() {
  return (
    <main>
      <h1>Middleware rewrite prefetch</h1>
      <Link id="rewritten-link" href="/middleware-rewrite-prefetch-target">
        rewritten link
      </Link>
    </main>
  );
}
