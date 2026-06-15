import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";

export default function RewriteNavigationPage() {
  const router = useRouter();
  const [navigateUrl, setNavigateUrl] = useState("");

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
      <Link
        data-testid="query-link"
        href="?id=3"
        onNavigate={(event) => setNavigateUrl(event.url.pathname + event.url.search)}
      >
        Link query
      </Link>
      <p data-testid="navigate-url">{navigateUrl}</p>
      <button
        data-testid="search-push"
        onClick={() => router.push({ query: { id: "ignored" }, search: "id=6", hash: "result" })}
      >
        Push search and hash
      </button>
      <button data-testid="bare-search-push" onClick={() => router.push({ search: "?" })}>
        Push bare search
      </button>
      <Link data-testid="bare-query-link" href="?">
        Link bare query
      </Link>
      <div id="result">Hash result</div>
    </main>
  );
}
