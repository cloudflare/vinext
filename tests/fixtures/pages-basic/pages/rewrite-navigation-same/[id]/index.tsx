import Link from "next/link";
import { useRouter } from "next/router";

export default function SameSegmentRewriteNavigationPage() {
  const router = useRouter();

  return (
    <main>
      <p data-testid="query-id">{router.query.id}</p>
      <p data-testid="as-path">{router.asPath}</p>
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
