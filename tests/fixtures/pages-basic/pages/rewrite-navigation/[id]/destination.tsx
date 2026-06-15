import Link from "next/link";
import { useRouter } from "next/router";

export default function RewriteNavigationPage() {
  const router = useRouter();

  return (
    <main style={{ minHeight: "200vh" }}>
      <h1>Rewrite Navigation Destination</h1>
      <p data-testid="pathname">{router.pathname}</p>
      <p data-testid="as-path">{router.asPath}</p>
      <p data-testid="query-id">{router.query.id}</p>
      <button data-testid="router-push" onClick={() => router.push({ query: { id: "1" } })}>
        Push query
      </button>
      <button data-testid="router-replace" onClick={() => router.replace({ query: { id: "2" } })}>
        Replace query
      </button>
      <Link data-testid="query-link" href="?id=3">
        Link query
      </Link>
    </main>
  );
}
